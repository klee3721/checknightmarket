# Night Market Checker

Ứng dụng local điều phối nhiều profile Edge/Chrome độc lập để xử lý danh sách tài khoản Riot qua Menzu. Mỗi profile giữ riêng phiên đăng nhập Menzu; mật khẩu Riot chỉ tồn tại trong RAM của tiến trình và URL token không được ghi log.

## Cài và chạy

Yêu cầu: Windows hoặc macOS, Node.js 20 trở lên, Microsoft Edge hoặc Google Chrome.

1. Trên Windows chạy `start.bat`. Lần đầu ứng dụng sẽ tự cài dependency. Trên macOS chạy `zsh start-mac.command`.
2. Dashboard mở tại `http://127.0.0.1:3210`.
3. Chuẩn bị `.xlsx` hoặc `.csv` với hai cột `id`, `pass`. Nếu ID có số 0 đầu, định dạng cột đó là **Text** trong Excel.
4. Chọn số luồng và bấm **Áp dụng**.
5. Với từng luồng, bấm **Mở / đăng nhập Menzu**, đăng nhập tài khoản Menzu tương ứng rồi bấm **Kiểm tra phiên**.
6. Nạp file tài khoản và bấm **Bắt đầu tất cả**.

Hướng dẫn chuyển máy nằm trong `WINDOWS_SETUP.md` và `MACBOOK_SETUP.md`. Profile/cookie không được chuyển giữa hai hệ điều hành; cần đăng nhập Menzu lại trên máy mới.

Lưu ý: server và dashboard hỗ trợ Windows, nhưng phần dò URL token của Chrome trong chế độ đăng nhập Riot thủ công hiện còn dùng AppleScript của macOS. Trước khi chạy luồng thật trên Windows, làm theo mục bàn giao trong `WINDOWS_SETUP.md` để hoàn thiện và kiểm thử phần này.

Trên macOS, launcher chỉ giữ một phiên chạy: trước khi khởi động lại, nó dừng server và browser profile cũ của project, đóng các tab dashboard/kết quả cũ và các Terminal `start-mac.command` đã rảnh. Tab/Terminal không thuộc project không bị tác động.

Ảnh được lưu tại `results/<id>/nightmarket_<thời-gian>.png`. File `results/results.csv` là bảng đối soát ID, ảnh, trạng thái, luồng và thời gian. Ảnh chẩn đoán khi lỗi nằm trong `runtime/errors`.

Dashboard có hai tab. Tab **Đang chạy** chỉ hiển thị hàng đợi chưa hoàn tất và log của phiên hiện tại. Tab **Đã check thành công** đọc trực tiếp các ảnh `nightmarket_*.png` trong `results/`, nên kết quả cũ vẫn hiển thị ngay cả khi server vừa restart và chưa nạp lại file tài khoản.

Sau khi nạp file và trước khi chạy, có thể chọn từng tài khoản hoặc Shift-click để chọn một dải, sau đó bỏ chọn hoặc xóa khỏi hàng đợi hiện tại. Tài khoản hợp lệ được chọn đầu tiên được đánh dấu **Bắt đầu**; nút chạy tất cả/chạy riêng luồng sẽ bắt đầu ở tài khoản đó rồi tiếp tục theo thứ tự, vòng lại phần đầu danh sách. Nếu không chọn tài khoản, hàng đợi bắt đầu từ dòng đầu tiên.

Nút **Check trùng đã thành công** so sánh ID trong hàng đợi vừa nạp với tab **Đã check thành công** (các ảnh hiện có trong `results/`) và xóa các ID trùng khỏi hàng đợi trong RAM. Thao tác này không xóa ảnh hay lịch sử kết quả và có thể khôi phục hàng đợi bằng cách nạp lại file.

## Chế độ chạy

- **Hiện trình duyệt**: tab Menzu của luồng được giữ nguyên. Ứng dụng lấy link Riot OAuth một lần và chỉ giữ trong RAM. Hãy tự đăng nhập Riot, hoàn tất CAPTCHA/MFA rồi bấm **Đã đăng nhập Riot · tiếp tục** trên dashboard. Ứng dụng mở link OAuth trong tab Chrome mới, bắt URL token localhost rồi quay về tab Menzu để check/chụp/xóa card. Cách này không dùng stealth hay vượt CAPTCHA.
- **Giữ Chrome Riot**: mặc định tùy chọn **Đóng Chrome Riot sau mỗi tài khoản** được tắt. Sau khi lấy token và xử lý Menzu, ứng dụng thử đăng xuất bằng giao diện Riot, xóa riêng cookie/storage Riot, đóng tab token và đưa cùng cửa sổ Chrome về trang Riot cho lượt kế tiếp. Bật tùy chọn này nếu muốn đóng và xóa profile Riot tạm sau từng tài khoản.
- **Chạy ngầm**: không hiện cửa sổ. Nếu Riot yêu cầu 2FA/CAPTCHA, tài khoản sẽ báo lỗi để chạy lại ở chế độ hiện.
- **Ảnh xem trước**: dashboard lấy ảnh tab đang hoạt động khoảng 1,5 giây/lần. Tắt tùy chọn này để giảm CPU.
- Nút **Dừng sau tài khoản hiện tại** không cắt ngang thao tác đang ghi/xóa dữ liệu.
- Có thể dùng **Chạy luồng này** sau khi sửa riêng một profile, kể cả khi các luồng khác còn đang xử lý.

## Khi giao diện website thay đổi

Selector được tách trong `config.json`. Log sẽ nêu nhóm selector bị lỗi, ví dụ `SELECTOR_NIGHT_CARDS`. Sửa danh sách tương ứng rồi khởi động lại ứng dụng. Các nhóm thường cần hiệu chỉnh sau khi đăng nhập thật:

Khi gặp lỗi `SELECTOR_*`, luồng tự tạm dừng và trả account hiện tại về hàng đợi để không làm lỗi liên tiếp các account sau.

- `selectors.menzu.archiveCards`
- `selectors.menzu.nightMarketCards`
- `selectors.menzu.nightMarketPanels`
- `selectors.menzu.deleteButtons`

Không thêm URL token hoặc mật khẩu vào `config.json`.

## An toàn dữ liệu

- Ứng dụng chỉ lắng nghe trên `127.0.0.1`, không mở dashboard ra mạng LAN.
- File Excel không được sao chép; mật khẩu không ghi xuống ổ đĩa, log hoặc API trạng thái.
- Mỗi lần xong một tài khoản, ứng dụng thử đăng xuất qua UI rồi xóa riêng cookie/storage Riot. Dữ liệu Menzu của profile được giữ lại.
- Thư mục `profiles/` chứa cookie phiên Menzu. Không chia sẻ hoặc đưa thư mục này lên Git/cloud.
- Tự động hóa hàng loạt có thể kích hoạt CAPTCHA/rate-limit và phải tuân thủ điều khoản của Riot/Menzu.

## Lệnh kỹ thuật

```powershell
npm install
npm test
npm run check
npm start
```

Nếu trình duyệt ở vị trí khác, đặt biến môi trường trước khi chạy:

```powershell
$env:NIGHTMARKET_BROWSER = 'D:\\Apps\\Chrome\\chrome.exe'
npm start
```
