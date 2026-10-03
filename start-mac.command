#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
DASHBOARD_URL="http://127.0.0.1:3210"
RESTARTING=0
cd "$PROJECT_DIR"

cleanup_previous_run() {
  local listener_pid listener_cwd browser_pid
  listener_pid="$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null | head -n 1)"
  if [[ -n "$listener_pid" ]]; then
    listener_cwd="$(lsof -a -p "$listener_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    if [[ "$listener_cwd" != "$PROJECT_DIR" ]]; then
      echo "Cổng 3210 đang được tiến trình khác sử dụng: PID $listener_pid"
      exit 1
    fi
    echo "Đang dừng phiên Night Market Checker cũ..."
    RESTARTING=1
    kill "$listener_pid" 2>/dev/null || true
    for _ in {1..30}; do
      kill -0 "$listener_pid" 2>/dev/null || break
      sleep 0.1
    done
  fi

  # Dọn các Chrome profile riêng của project còn sót nếu phiên trước bị đóng đột ngột.
  ps -axo pid=,command= | while read -r browser_pid command_line; do
    if [[ "$command_line" == *"--user-data-dir=$PROJECT_DIR/profiles/worker-"* \
      || "$command_line" == *"--user-data-dir=$PROJECT_DIR/runtime/worker-"* ]]; then
      kill "$browser_pid" 2>/dev/null || true
    fi
  done

  # Chỉ đóng Terminal cũ do launcher này tạo; giữ Terminal đang chạy và tab không liên quan.
  /usr/bin/osascript >/dev/null 2>&1 <<'APPLESCRIPT' || true
tell application "Terminal"
  repeat with windowIndex from (count of windows) to 1 by -1
    set terminalWindow to window windowIndex
    if (count of tabs of terminalWindow) is 1 then
      set terminalTab to selected tab of terminalWindow
      set tabTitle to ""
      try
        set tabTitle to custom title of terminalTab as text
      end try
      if tabTitle is "start-mac.command" and busy of terminalTab is false then close terminalWindow
    end if
  end repeat
end tell
APPLESCRIPT
}

cleanup_previous_run

if ! command -v node >/dev/null 2>&1; then
  echo "Chưa có Node.js. Hãy cài Node.js 20 trở lên từ https://nodejs.org rồi chạy lại."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Đang cài thư viện lần đầu..."
  npm ci
fi

if [[ "$RESTARTING" -eq 0 ]]; then
  (sleep 2; open "$DASHBOARD_URL" >/dev/null 2>&1) &
else
  echo "Giữ nguyên tab dashboard hiện tại; không mở thêm tab mới."
fi
exec npm start
