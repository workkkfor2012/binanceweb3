# run_gui.py
import sys
import json
import subprocess
import threading
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QGridLayout, 
    QPushButton, QTextEdit, QLabel, QScrollArea, QTabWidget
)
from PySide6.QtCore import Qt, Signal, Slot
from PySide6.QtGui import QFont

# --- 核心应用窗口 ---
class App(QMainWindow):
    # 自定义信号： (脚本名称, 日志行)
    log_signal = Signal(str, str)
    # 自定义信号： (脚本名称)
    process_finished_signal = Signal(str)

    def __init__(self):
        super().__init__()
        self.setWindowTitle("项目控制面板 (多任务版)")
        self.setGeometry(100, 100, 900, 700)

        # 存储正在运行的子进程: { "script_name": subprocess.Popen_instance }
        self.processes = {}
        # 存储每个脚本对应的日志窗口: { "script_name": QTextEdit_instance }
        self.log_widgets = {}

        self.init_ui()
        self.load_scripts()

        self.log_signal.connect(self.append_log)
        self.process_finished_signal.connect(self.on_process_finished)

    def init_ui(self):
        main_widget = QWidget()
        main_layout = QVBoxLayout(main_widget)
        self.setCentralWidget(main_widget)

        # 脚本按钮区域
        scripts_label = QLabel("可执行脚本:")
        main_layout.addWidget(scripts_label)
        
        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        scroll_widget = QWidget()
        self.scripts_layout = QGridLayout(scroll_widget)
        self.scripts_layout.setAlignment(Qt.AlignTop)
        scroll_area.setWidget(scroll_widget)
        main_layout.addWidget(scroll_area, 1)

        # 日志输出区域 (使用 QTabWidget)
        log_label = QLabel("日志输出:")
        self.tabs = QTabWidget()
        self.tabs.setTabsClosable(True)
        self.tabs.tabCloseRequested.connect(self.close_tab)
        
        main_layout.addWidget(log_label)
        main_layout.addWidget(self.tabs, 3)

    def load_scripts(self):
        try:
            with open("package.json", "r", encoding="utf-8") as f:
                scripts = json.load(f).get("scripts", {})
            
            row, col = 0, 0
            for name, command in scripts.items():
                button = QPushButton(f"Run {name}")
                button.setToolTip(command)
                button.setObjectName(f"btn_{name}")
                button.clicked.connect(lambda checked, n=name: self.run_script(n))
                self.scripts_layout.addWidget(button, row, col)
                col = (col + 1) % 4
                if col == 0: row += 1
        except Exception as e:
            self.tabs.addTab(QTextEdit(f"错误: 无法加载 package.json -> {e}"), "错误")

    def run_script(self, name):
        if name in self.processes:
            # 如果脚本已在运行，则切换到它的标签页
            if name in self.log_widgets:
                for i in range(self.tabs.count()):
                    if self.tabs.widget(i) == self.log_widgets[name]:
                        self.tabs.setCurrentIndex(i)
                        break
            return

        # 创建新的日志窗口和标签页
        log_output = QTextEdit()
        log_output.setReadOnly(True)
        log_output.setFont(QFont("Courier New", 10))
        log_output.setStyleSheet("background-color: #2b2b2b; color: #f0f0f0;")
        
        tab_index = self.tabs.addTab(log_output, name)
        self.tabs.setCurrentIndex(tab_index)
        self.log_widgets[name] = log_output

        self.append_log(name, f"--- 启动脚本: {name} ---")
        
        command = ["cmd", "/c", "pnpm", "run", name] if sys.platform == "win32" else ["pnpm", "run", name]

        try:
            flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                creationflags=flags
            )
            self.processes[name] = process
            
            threading.Thread(target=self.read_output, args=(process, name), daemon=True).start()
            threading.Thread(target=self.wait_for_process, args=(process, name), daemon=True).start()

            btn = self.findChild(QPushButton, f"btn_{name}")
            if btn:
                btn.setText(f"Running: {name}")
                btn.setStyleSheet("background-color: #5c6370;") # 灰色表示运行中
                btn.setEnabled(False) # 运行时不可点击

        except Exception as e:
            self.append_log(name, f"错误: 启动脚本 '{name}' 失败 -> {e}")
            self.on_process_finished(name) # 启动失败也算结束

    def stop_script(self, name):
        process = self.processes.get(name)
        if process:
            self.append_log(name, f"--- 正在手动停止脚本: {name} ---")
            try:
                if sys.platform == "win32":
                    subprocess.run(f"taskkill /F /T /PID {process.pid}", check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                else: # macOS / Linux
                    process.terminate()
                    process.wait(timeout=5)
            except Exception:
                process.kill()

    def read_output(self, process, name):
        if process.stdout:
            for line in iter(process.stdout.readline, ''):
                self.log_signal.emit(name, line.strip())
            process.stdout.close()

    def wait_for_process(self, process, name):
        process.wait()
        self.process_finished_signal.emit(name)

    @Slot(str, str)
    def append_log(self, script_name, text):
        if script_name in self.log_widgets:
            log_widget = self.log_widgets[script_name]
            log_widget.append(text)
            log_widget.verticalScrollBar().setValue(log_widget.verticalScrollBar().maximum())

    @Slot(str)
    def on_process_finished(self, name):
        self.append_log(name, f"--- 脚本: {name} 已结束 ---")
        
        if name in self.processes:
            del self.processes[name]
        
        # 恢复按钮状态
        btn = self.findChild(QPushButton, f"btn_{name}")
        if btn:
            btn.setText(f"Run {name}")
            btn.setStyleSheet("")
            btn.setEnabled(True)

        # 更新标签页标题
        if name in self.log_widgets:
            for i in range(self.tabs.count()):
                if self.tabs.widget(i) == self.log_widgets[name]:
                    self.tabs.setTabText(i, f"{name} [已结束]")
                    break

    @Slot(int)
    def close_tab(self, index):
        widget = self.tabs.widget(index)
        # 找到与此widget关联的脚本名称
        script_name_to_close = None
        for name, log_widget in self.log_widgets.items():
            if log_widget == widget:
                script_name_to_close = name
                break
        
        if script_name_to_close:
            # 如果进程仍在运行，先停止它
            if script_name_to_close in self.processes:
                self.stop_script(script_name_to_close)
            
            # 清理资源
            if script_name_to_close in self.log_widgets:
                del self.log_widgets[script_name_to_close]

        self.tabs.removeTab(index)
        widget.deleteLater()


    def closeEvent(self, event):
        for name in list(self.processes.keys()):
            self.stop_script(name)
        event.accept()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    ex = App()
    ex.show()
    sys.exit(app.exec())