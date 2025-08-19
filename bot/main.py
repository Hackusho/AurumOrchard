import os
import json
from web3 import Web3
from eth_abi import encode as abi_encode

# --- Environment Variables ---
RPC_URL = os.getenv("ARBITRUM_MAINNET_RPC_URL")
SEED_KEY = os.getenv("SEED_KEY")
ROOT_KEY = os.getenv("ROOT_KEY")
GOLDSTEM_ADDRESS = os.getenv("GOLDSTEM_ADDRESS")
FLASH_EXECUTOR_ADDRESS = os.getenv("FLASH_EXECUTOR_ADDRESS")
FLASH_ASSET = os.getenv("FLASH_ASSET")  # e.g., WETH address if borrowing WETH
FLASH_AMOUNT_WEI = int(os.getenv("FLASH_AMOUNT_WEI", "0"))
MIN_PROFIT_WEI = int(os.getenv("MIN_PROFIT_WEI", "0"))

# Uniswap V3 (Arbitrum One defaults are fine, but overridable via .env)
UNIV3_ROUTER = os.getenv("UNIV3_ROUTER", "0xE592427A0AEce92De3Edee1F18E0157C05861564")
UNIV3_QUOTER = os.getenv("UNIV3_QUOTER", "0x61fFE01658eEe6eCeC4dFAbFfC31aBa7b4D48c57")
WETH = os.getenv("WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1")
USDC = os.getenv("USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")

# --- Constants: ABI artifact paths (Hardhat default) ---
HERE = os.path.dirname(__file__)
GOLDSTEM_ABI_PATH = os.path.join(HERE, "../artifacts/contracts/Goldstem.sol/Goldstem.json")
FLASH_EXECUTOR_ABI_PATH = os.path.join(HERE, "../artifacts/contracts/FlashloanExecutor.sol/FlashloanExecutor.json")

# --- Minimal ABIs ---
QUOTER_V2_ABI = [{
    "inputs": [
        {"internalType":"bytes","name":"path","type":"bytes"},
        {"internalType":"uint256","name":"amountIn","type":"uint256"}
    ],
    "name":"quoteExactInput",
    "outputs":[
        {"internalType":"uint256","name":"amountOut","type":"uint256"},
        {"internalType":"uint160[]","name":"sqrtPriceX96AfterList","type":"uint160[]"},
        {"internalType":"uint32[]","name":"initializedTicksCrossedList","type":"uint32[]"},
        {"internalType":"uint256","name":"gasEstimate","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"function"
}]

# -------------------- Utils --------------------
def to_checksum(addr: str) -> str:
    return Web3.to_checksum_address(addr)

def load_abi(path):
    if not os.path.exists(path):
        raise FileNotFoundError(f"ABI not found: {path}")
    with open(path, "r") as f:
        return json.load(f)["abi"]

def suggest_fees(w3: Web3):
    """
    Conservative EIP-1559 fee suggestions for Arbitrum RPC v1.
    """
    try:
        max_priority = w3.eth.max_priority_fee()
    except Exception:
        # Some providers don’t support this; fall back to a tiny tip.
        max_priority = int(w3.to_wei("0.0000002", "ether"))  # 0.2 gwei equivalent
    latest = w3.eth.get_block("latest")
    base = latest.get("baseFeePerGas", w3.eth.gas_price)
    max_fee = base * 2 + max_priority
    return int(max_fee), int(max_priority)

def send_tx(w3: Web3, tx: dict, signer):
    """
    Sets nonce, EIP-1559 fees, estimates gas, signs, sends, waits for receipt.
    """
    tx["nonce"] = w3.eth.get_transaction_count(signer.address)
    tx["chainId"] = w3.eth.chain_id

    # EIP-1559 fees
    max_fee, max_prio = suggest_fees(w3)
    tx.setdefault("maxFeePerGas", max_fee)
    tx.setdefault("maxPriorityFeePerGas", max_prio)

    # Estimate gas
    tx["gas"] = w3.eth.estimate_gas({**tx, "from": signer.address})
    signed = w3.eth.account.sign_transaction(tx, signer.key)
    txh = w3.eth.send_raw_transaction(signed.rawTransaction)
    print(f"  tx sent: {txh.hex()}")
    rcpt = w3.eth.wait_for_transaction_receipt(txh)
    print(f"  status: {'Success' if rcpt.status == 1 else 'Failed'}  gasUsed: {rcpt.gasUsed}")
    return rcpt

# -------------------- Uniswap V3 helpers --------------------
def _to20(addr: str) -> bytes:
    return bytes.fromhex(to_checksum(addr)[2:])

def _fee3(fee: int) -> bytes:
    return int(fee).to_bytes(3, byteorder="big")

def encode_v3_path(tokens: list[str], fees: list[int]) -> bytes:
    assert len(tokens) >= 2 and len(fees) == len(tokens) - 1, "bad path lens"
    out = bytearray()
    out += _to20(tokens[0])
    for i, f in enumerate(fees):
        out += _fee3(f)
        out += _to20(tokens[i+1])
    return bytes(out)

def encode_flash_params_for_roundtrip(w3: Web3,
                                      asset_in: str,
                                      mid_token: str,
                                      fee_in_to_mid: int,
                                      fee_mid_to_out: int,
                                      amount_in_wei: int,
                                      premium_estimate_wei: int = 0,
                                      safety_buffer_bps: int = 30):
    """
    Build a roundtrip path (asset -> mid -> asset), quote it via QuoterV2,
    and produce (params_bytes, min_out, quoted_out).
    """
    asset_in = to_checksum(asset_in)
    mid_token = to_checksum(mid_token)

    path = encode_v3_path([asset_in, mid_token, asset_in],
                          [fee_in_to_mid, fee_mid_to_out])

    quoter = w3.eth.contract(address=to_checksum(UNIV3_QUOTER), abi=QUOTER_V2_ABI)
    quoted_out = quoter.functions.quoteExactInput(path, int(amount_in_wei)).call()[0]

    repay_target = int(amount_in_wei) + int(premium_estimate_wei)
    min_out = max(repay_target + (repay_target * safety_buffer_bps // 10_000), 1)

    params_bytes = abi_encode(["bytes", "uint256"], [path, min_out])
    return params_bytes, int(min_out), int(quoted_out)

# -------------------- Core flows --------------------
def seed_to_root(w3, amount_eth, seed_account, root_account):
    print(f"Sending {amount_eth} ETH Seed → Root")
    tx = {
        "to": root_account.address,
        "value": w3.to_wei(amount_eth, "ether"),
        "from": seed_account.address,
    }
    send_tx(w3, tx, seed_account)

def split_via_goldstem(w3, amount_eth, root_account, goldstem_contract):
    """
    If Goldstem auto-splits in receive(), sending ETH is enough.
    """
    print(f"Splitting {amount_eth} ETH via Goldstem (send to receive())")
    tx = {
        "to": goldstem_contract.address,
        "value": w3.to_wei(amount_eth, "ether"),
        "from": root_account.address,
    }
    send_tx(w3, tx, root_account)

def flashloan_and_arb(w3, seed_account, root_account, flash_executor_contract, goldstem_contract):
    print("\n--- Flashloan & Arb ---")
    if not FLASH_EXECUTOR_ADDRESS or not FLASH_ASSET or FLASH_AMOUNT_WEI <= 0:
        print("Flashloan env not configured (executor/asset/amount). Skipping.")
        return

    # Ensure root owns the executor
    try:
        owner = flash_executor_contract.functions.owner().call()
        if owner != root_account.address:
            print(f"Root is not owner of FlashExecutor. Owner is {owner}. Aborting flashloan.")
            return
    except Exception as e:
        print(f"Could not fetch FlashExecutor owner: {e}")
        return

    # Build Uniswap V3 roundtrip params for the borrowed asset
    try:
        params_bytes, min_out, quote = encode_flash_params_for_roundtrip(
            w3=w3,
            asset_in=FLASH_ASSET,  # e.g., WETH
            mid_token=USDC,        # roundtrip via USDC; change as needed
            fee_in_to_mid=500,     # 0.05%
            fee_mid_to_out=500,    # 0.05%
            amount_in_wei=FLASH_AMOUNT_WEI,
            premium_estimate_wei=w3.to_wei(0.0000005, "ether"),  # tiny guess; on-chain check rules
            safety_buffer_bps=30
        )
        print(f"[QUOTE] in={FLASH_AMOUNT_WEI}  quotedOut={quote}  minOut(enforced)={min_out}")
    except Exception as e:
        print("Failed to quote/encode Uniswap V3 path:", e)
        return

    print(f"Attempting flashloan of {FLASH_AMOUNT_WEI} wei for asset {FLASH_ASSET} with swap params...")

    # Owner must call runSimpleFlash (executor is Ownable)
    tx = flash_executor_contract.functions.runSimpleFlash(
        to_checksum(FLASH_ASSET), int(FLASH_AMOUNT_WEI), params_bytes
    ).build_transaction({
        "from": root_account.address,  # must be executor owner
    })

    rcpt = send_tx(w3, tx, root_account)

    # Decode FlashCompleted from receipt
    profit = 0
    try:
        evts = flash_executor_contract.events.FlashCompleted().process_receipt(rcpt)
        if evts:
            profit = int(evts[-1]["args"]["profitWei"])
            print(f"  FlashCompleted: profit = {profit} wei")
    except Exception as e:
        print("  Could not decode FlashCompleted:", e)

    # Route to Goldstem if profitable
    if profit > MIN_PROFIT_WEI:
        print(f"  GO! Profit ({profit}) > min profit ({MIN_PROFIT_WEI}).")
        print("  Sending dust from Root → Goldstem as post-profit route test...")
        split_via_goldstem(w3, 0.00001, root_account, goldstem_contract)
    else:
        print(f"  NO-GO. Profit ({profit}) <= min profit ({MIN_PROFIT_WEI}).")

# -------------------- Main --------------------
def main():
    print("--- Aurum Orchard Trading Bot ---")

    if not RPC_URL:
        raise EnvironmentError("ARBITRUM_MAINNET_RPC_URL not set")
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        raise ConnectionError("Failed to connect to RPC_URL")

    print(f"Connected to: {RPC_URL}")
    print(f"ChainId: {w3.eth.chain_id}")

    if not SEED_KEY or not ROOT_KEY:
        raise EnvironmentError("SEED_KEY and ROOT_KEY must be set")
    seed = w3.eth.account.from_key(SEED_KEY)
    root = w3.eth.account.from_key(ROOT_KEY)
    print(f"Seed: {seed.address}")
    print(f"Root: {root.address}")

    if not GOLDSTEM_ADDRESS:
        raise EnvironmentError("GOLDSTEM_ADDRESS not set")
    goldstem_abi = load_abi(GOLDSTEM_ABI_PATH)
    goldstem = w3.eth.contract(address=to_checksum(GOLDSTEM_ADDRESS), abi=goldstem_abi)
    print(f"Goldstem: {goldstem.address}")

    flash_executor = None
    if FLASH_EXECUTOR_ADDRESS:
        flash_abi = load_abi(FLASH_EXECUTOR_ABI_PATH)
        flash_executor = w3.eth.contract(address=to_checksum(FLASH_EXECUTOR_ADDRESS), abi=flash_abi)
        print(f"FlashExecutor: {flash_executor.address}")
        try:
            exec_owner = flash_executor.functions.owner().call()
            print(f"FlashExecutor Owner: {exec_owner}")
        except Exception as e:
            print(f"Could not fetch FlashExecutor owner: {e}")
    else:
        print("FlashExecutor not configured (set FLASH_EXECUTOR_ADDRESS to enable).")

    # Balances
    sbal = w3.eth.get_balance(seed.address)
    rbal = w3.eth.get_balance(root.address)
    print(f"Seed Balance: {w3.from_wei(sbal, 'ether')} ETH")
    print(f"Root Balance: {w3.from_wei(rbal, 'ether')} ETH")

    # Safety: verify Root is owner (if Goldstem is Ownable)
    print("\n--- Safety Check ---")
    try:
        owner = goldstem.functions.owner().call()
        if owner == root.address:
            print("Root is Goldstem owner. Proceeding.")
        else:
            print(f"Root is not owner of Goldstem. Owner is {owner}. Aborting.")
            return
    except Exception as e:
        print(f"Owner() check failed (maybe not Ownable?): {e}")
        # If your Goldstem doesn’t expose owner(), you can safely proceed or add role checks here.

    # Dust test (Seed → Root → Goldstem)
    print("\n--- Dust Test ---")
    seed_to_root(w3, 0.00003, seed, root)
    split_via_goldstem(w3, 0.00002, root, goldstem)

    # Flashloan (HTTP RPC v1)
    if flash_executor:
        flashloan_and_arb(w3, seed, root, flash_executor, goldstem)

if __name__ == "__main__":
    main()
