# @file menu.py
# @project PipkerOps
# @module deployment/menu
# @description 主控容器和本地 Agent 的统一管理菜单。
# @logic 按组件选择子菜单，将 Ops 安装、镜像测速与服务启停分开执行。
# @dependencies Python 3, deployment core, Agent management
# @index_tags deployment, menu, agent
# @author holic512
from internal.core import main as control_main
from internal.agent import main as agent_main


def menu():
    while True:
        try:
            choice = input('\nPipkerOps 管理\n1. 主控管理\n2. Agent 管理\n0. 退出\n请选择：').strip()
            if choice == '0':
                return
            if choice == '1':
                control_menu()
            elif choice == '2':
                agent_menu()
            else:
                print('请选择有效编号。')
        except (EOFError, KeyboardInterrupt):
            print()
            return


def control_menu():
    options = {'1': 'install', '2': 'status', '3': 'start', '4': 'stop', '5': 'restart', '6': 'update', '7': 'mirrors'}
    while True:
        choice = input('\n主控管理\n1. 安装 Ops（不启动）\n2. 查看详情\n3. 启动\n4. 停止\n5. 重启\n6. 更新\n7. 镜像源测速\n0. 返回\n请选择：').strip()
        if choice == '0':
            return
        if choice not in options:
            print('请选择有效编号。')
            continue
        version = input('目标版本（例如 0.1.4 或 edge）：').strip() if choice == '6' else None
        control_main(options[choice], version)


def agent_menu():
    options = {'1': 'install', '2': 'status', '3': 'start', '4': 'stop', '5': 'restart', '6': 'export', '7': 'reset-key'}
    while True:
        choice = input('\nAgent 管理\n1. 安装／重新安装\n2. 查看详情\n3. 启动并设为开机自启\n4. 停止\n5. 重启\n6. 导出接入文件（含访问 Key）\n7. 重置访问 Key（先停止服务）\n0. 返回\n请选择：').strip()
        if choice == '0':
            return
        if choice not in options:
            print('请选择有效编号。')
            continue
        package = input('本地 Agent .tar.gz 安装包路径（同目录需有 SHA256SUMS）：').strip() if choice == '1' else None
        if choice == '7' and input('旧接入文件将失效，输入 RESET 确认：').strip() != 'RESET':
            continue
        agent_main(options[choice], package)


if __name__ == '__main__':
    menu()
