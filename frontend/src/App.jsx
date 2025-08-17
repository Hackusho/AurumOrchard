import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { goldstemABI } from './abi.js';
import './App.css';


const rpcUrl = import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC_URL;
const contractAddress = import.meta.env.VITE_GOLDSTEM_CONTRACT_ADDRESS;

function App() {
  const [owner, setOwner] = useState('');
  const [fruitWallet, setFruitWallet] = useState('');
  const [branchesWallet, setBranchesWallet] = useState('');
  const [fruitShare, setFruitShare] = useState(0);
  const [branchesShare, setBranchesShare] = useState(0);
  const [contractBalance, setContractBalance] = useState('');
  const [error, setError] = useState('');

  // New state for wallet connection
  const [account, setAccount] = useState('');
  const [balance, setBalance] = useState('');
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [contract, setContract] = useState(null);


  useEffect(() => {
    const fetchContractData = async () => {
      try {
        if (!rpcUrl || !contractAddress) {
          throw new Error("Missing RPC URL or Contract Address in .env file");
        }

        const jsonRpcProvider = new ethers.JsonRpcProvider(rpcUrl);
        const goldstemContract = new ethers.Contract(contractAddress, goldstemABI, jsonRpcProvider);
        setContract(goldstemContract);

        const owner = await goldstemContract.owner();
        const fruitWallet = await goldstemContract.fruitWallet();
        const branchesWallet = await goldstemContract.branchesWallet();
        const fruitShare = await goldstemContract.fruitShare();
        const branchesShare = await goldstemContract.branchesShare();
        const balance = await jsonRpcProvider.getBalance(contractAddress);

        setOwner(owner);
        setFruitWallet(fruitWallet);
        setBranchesWallet(branchesWallet);
        setFruitShare(Number(fruitShare));
        setBranchesShare(Number(branchesShare));
        setContractBalance(ethers.formatEther(balance));
      } catch (err) {
        console.error("Error fetching contract data:", err);
        setError(err.message);
      }
    };

    fetchContractData();
  }, []);

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        throw new Error("MetaMask not detected. Please install MetaMask.");
      }

      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      setProvider(browserProvider);

      const accounts = await browserProvider.send("eth_requestAccounts", []);
      const account = accounts[0];
      setAccount(account);

      const walletSigner = await browserProvider.getSigner();
      setSigner(walletSigner);

      const balance = await browserProvider.getBalance(account);
      setBalance(ethers.formatEther(balance));

    } catch (err) {
      console.error("Error connecting wallet:", err);
      setError(err.message);
    }
  };

  const [sendAmount, setSendAmount] = useState('');

  const sendEther = async () => {
    try {
      if (!signer) {
        throw new Error("Wallet not connected");
      }
      const tx = await signer.sendTransaction({
        to: contractAddress,
        value: ethers.parseEther(sendAmount)
      });
      await tx.wait();
      alert("Ether sent successfully!");
      // Refresh balance
      const balance = await provider.getBalance(account);
      setBalance(ethers.formatEther(balance));
      const contractBalance = await provider.getBalance(contractAddress);
      setContractBalance(ethers.formatEther(contractBalance));
      setSendAmount('');
    } catch (err) {
      console.error("Error sending ether:", err);
      setError(err.message);
    }
  };

  const [newFruitWallet, setNewFruitWallet] = useState('');
  const [newBranchesWallet, setNewBranchesWallet] = useState('');

  const handleSetWallets = async () => {
    try {
      if (!signer) {
        throw new Error("Wallet not connected");
      }
      const contractWithSigner = contract.connect(signer);
      const tx = await contractWithSigner.setWallets(newFruitWallet, newBranchesWallet);
      await tx.wait();
      alert("Wallets updated successfully!");
      // Refresh wallet data
      const fruitWallet = await contract.fruitWallet();
      const branchesWallet = await contract.branchesWallet();
      setFruitWallet(fruitWallet);
      setBranchesWallet(branchesWallet);
      setNewFruitWallet('');
      setNewBranchesWallet('');
    } catch (err) {
      console.error("Error setting wallets:", err);
      setError(err.message);
    }
  };

  const handleWithdraw = async () => {
    try {
      if (!signer) {
        throw new Error("Wallet not connected");
      }
      const contractWithSigner = contract.connect(signer);
      const tx = await contractWithSigner.withdraw();
      await tx.wait();
      alert("Withdrawal successful!");
      // Refresh balance
      const balance = await provider.getBalance(account);
      setBalance(ethers.formatEther(balance));
      const contractBalance = await provider.getBalance(contractAddress);
      setContractBalance(ethers.formatEther(contractBalance));
    } catch (err) {
      console.error("Error withdrawing funds:", err);
      setError(err.message);
    }
  };

  return (
    <>
      <h1>Aurum Orchard</h1>

      <div className="card">
        <h2>Wallet</h2>
        {account ? (
          <div>
            <p><strong>Connected Account:</strong> {account}</p>
            <p><strong>Balance:</strong> {balance} ETH</p>
            <div className="action-container">
              <input
                type="text"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                placeholder="Amount in ETH"
              />
              <button onClick={sendEther}>Send Ether</button>
            </div>
          </div>
        ) : (
          <button onClick={connectWallet}>Connect Wallet</button>
        )}
      </div>

      <div className="card">
        <h2>Goldstem Contract Details</h2>
        {error ? (
          <p className="error">Error: {error}</p>
        ) : (
          <div>
            <p><strong>Contract Address:</strong> {contractAddress}</p>
            <p><strong>Contract Balance:</strong> {contractBalance} ETH</p>
            <p><strong>Owner (Roots Wallet):</strong> {owner}</p>
            <p><strong>Fruit Wallet:</strong> {fruitWallet}</p>
            <p><strong>Branches Wallet:</strong> {branchesWallet}</p>
            <p><strong>Fruit Share:</strong> {fruitShare}%</p>
            <p><strong>Branches Share:</strong> {branchesShare}%</p>
          </div>
        )}
      </div>

      {account && account.toLowerCase() === owner.toLowerCase() && (
        <div className="card">
          <h2>Owner Actions</h2>
          <div className="action-container">
            <h3>Set Wallets</h3>
            <input
              type="text"
              value={newFruitWallet}
              onChange={(e) => setNewFruitWallet(e.target.value)}
              placeholder="New Fruit Wallet Address"
            />
            <input
              type="text"
              value={newBranchesWallet}
              onChange={(e) => setNewBranchesWallet(e.target.value)}
              placeholder="New Branches Wallet Address"
            />
            <button onClick={handleSetWallets}>Set Wallets</button>
          </div>
          <div className="action-container">
            <h3>Withdraw Funds</h3>
            <button onClick={handleWithdraw}>Withdraw</button>
          </div>
        </div>
      )}
    </>
  )
}

export default App