import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from internal.core import main

if __name__ == '__main__':
    sys.exit(main('stop'))
