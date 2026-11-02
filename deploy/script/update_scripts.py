# @file update_scripts.py
# @project PipkerOps
# @module deployment/script-update-cli
# @description 从本地已分发归档更新指定部署目录的程序文件。
# @logic 入口参数交给统一清单更新器，失败不覆盖本地修改。
# @dependencies Python 3, script_updates
# @index_tags scripts, update, cli
# @author holic512
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from internal.script_updates import update_scripts
if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise RuntimeError('用法：update_scripts.py PACKAGE SHA256')
        print(json.dumps(update_scripts(Path(__file__).resolve().parent.parent, sys.argv[1], sys.argv[2]), ensure_ascii=False))
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
