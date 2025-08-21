import os, subprocess, sys
env = os.environ.copy()
node_bot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "midas.js")
sys.exit(subprocess.call(["node", node_bot], env=env))
