import os, subprocess, sys
env = os.environ.copy()
node_bot = os.path.join(os.path.dirname(__file__), "arb_bot.js")
sys.exit(subprocess.call(["node", node_bot], env=env))
