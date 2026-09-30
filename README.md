# enthstudio

Không gian làm việc local cho đội AI phát triển game. Giao diện nhóm chat chạy trong Docker Compose; Codex CLI trong container `runtime` dùng tài khoản ChatGPT của bạn. Mỗi công việc có phiên Codex riêng cho từng role. Tin nhắn trong giao diện được lưu để theo dõi, nhưng không tự gửi lại toàn bộ lịch sử vào model.

## Chạy ứng dụng

Yêu cầu Docker Desktop với Linux containers. Trong thư mục dự án:

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

Mở [http://127.0.0.1:3000](http://127.0.0.1:3000). Cổng chỉ mở trên `127.0.0.1`.

Đăng nhập Codex trong container bằng tài khoản ChatGPT Plus:

```powershell
docker compose exec runtime codex login --device-auth
```

Nếu Codex trên máy đã đăng nhập bằng ChatGPT và có file `C:\Users\admin\.codex\auth.json`, có thể sao chép cache xác thực vào volume container theo hướng dẫn chính thức của Codex:

```powershell
docker compose cp "$env:USERPROFILE\.codex\auth.json" runtime:/codex-state/auth.json
docker compose exec runtime codex login status
```

Cache chứa access token: không đưa file này vào Git, chat hoặc ảnh Docker. Volume `codex-state` giữ trạng thái đăng nhập và phiên qua các lần khởi động lại. Nếu tài khoản dùng credential store thay vì `auth.json`, dùng device login.

## Sử dụng

- Gửi `@developer ...`, `@designer ...`, `@architect ...`, `@reviewer ...`, `@art-ux ...` hoặc `@lead ...` trong một kênh. Tin không mention được chuyển đến Lead.
- Các kênh `gameplay`, `engineering`, `art-ux`, `qa` và `decisions` là các luồng tổng hợp từ cuộc trao đổi task chung: Designer, Architect/Developer, Art/UX, Reviewer/QA và Lead/vote tương ứng được hiển thị theo vai trò mà không tạo thêm lượt gọi model hay nhân bản tin nhắn.
- **Serious project workflow là mặc định.** Mọi yêu cầu tạo, sửa, review, hardening hoặc tiếp tục một project sẽ được đưa qua Lead → Designer + Architect + Art / UX (ý kiến độc lập) → Lead hợp nhất plan → **bạn review plan** → Developer → Reviewer / QA → Lead. Task dừng ở `Chờ bạn duyệt plan`; gửi `@lead duyệt plan` để bắt đầu triển khai hoặc `@lead sửa plan: ...` để yêu cầu cập nhật. Nếu người dùng tag trực tiếp một role khác cho project work, tag đó được giữ làm ngữ cảnh nhưng Lead vẫn mở đầy đủ pipeline. Chỉ Reviewer `approve` mới cho Lead chốt; nếu clone sang máy khác rồi tạo database mới, policy và model mặc định được seed từ `src/db.js`.
- Mỗi tin nhắn mới trong kênh tạo một task. Mở **Công việc**, chọn task để tiếp tục đúng phiên và xem riêng cuộc trao đổi của task đó.
- Agent có thể giao tiếp cho role khác qua kết quả có cấu trúc. Người giao nghỉ trong lúc người nhận làm; khi người nhận xong, hệ thống gọi lại người giao bằng báo cáo ngắn.
- **Agents** tự tải model và reasoning effort đang khả dụng từ Codex subscription trong container runtime; bạn có thể chỉnh model, effort, bật/tạm ngưng từng role. Các lựa chọn chỉ áp dụng cho lượt chạy sau.
- **Tài liệu** cho phép xem và sửa Markdown của dự án và từng agent.
- **Agent memories** cho phép xem hai lớp Markdown trong `agent_memories/`: memory dài hạn `global/<role>.md` và memory riêng task `task-<id>/<role>.md` cùng `task-<id>/SUMMARY.md`. Mỗi lượt hoàn tất phải trả trường `memory`; worker tự ghi quyết định bền vững vào cả hai lớp, có fallback từ báo cáo nếu agent không gửi ghi chú. Khi gọi lượt tiếp theo, worker nạp memory phù hợp thay vì gửi lại toàn bộ lịch sử chat. Các file này nằm trong `game-workspace` nên được giữ khi restart/rebuild và có thể commit lên GitHub để clone sang máy khác.
- **Git diff** là menu chỉ đọc cho branch, working tree, diff đã/chưa stage và năm commit gần nhất.
- **Previews** chạy trong Docker. Developer đặt project ở `game-workspace/projects/<slug>/`, gồm `enthstudio.project.json`, ví dụ `{"name":"Guess Number","taskId":12}`. Project có `Dockerfile` sẽ được preview manager build từ đúng context, cấp volume dữ liệu riêng, bind vào một port `127.0.0.1` gồm năm chữ số và chỉ báo `running` sau khi container sống và healthcheck đạt. Project chỉ có `index.html` được phục vụ bằng static fallback trong Docker. Preview manager kiểm tra trùng port, xóa metadata stale và hiện URL trong giao diện. Lead chỉ đóng task có project sau khi preview `running`, rồi trả báo cáo bàn giao gồm đường dẫn, URL, port, image, volume và kiểm tra Docker.
- **Port forward** dùng Cloudflare Quick Tunnel. Image Docker cài sẵn `cloudflared`, nhưng tunnel không tự khởi chạy. Trong menu **Previews**, bấm **Port forward** trên project đang chạy để tạo URL `trycloudflare.com`; bấm **Dừng port forward** để tắt. Quick Tunnel là URL tạm thời, có thể thay đổi sau khi dừng hoặc khởi động lại.
- Lead cũng có thể nhận lệnh rõ ràng trong chat, ví dụ `@lead tạo quick tunnel cho flappy-bird` hoặc `@lead port forward task #12`. Hệ thống gọi `tunnel-manager` trực tiếp để tiết kiệm một lượt Codex, ghi lại URL và port vào task rồi đóng task khi tunnel tạo xong. Tab **Settings** chỉ lưu token Cloudflare tùy chọn cho named tunnel trong tương lai; Quick Tunnel hiện tại không cần token hay đăng nhập.
- **Lượt chạy** hiển thị trạng thái, cho phép dừng lượt đang chờ hoặc đang chạy, và đo bốn mốc: **Ngủ** (thời gian từ lượt trước của agent), **Chờ** (thời gian trong hàng đợi), **Đánh thức** (khởi động Codex CLI đến output đầu tiên), **Xử lý** (thời gian còn lại đến kết quả).
- Trong kênh chat, chỉ báo `Lead is typing…` hoặc `Lead, Developer and Architect are typing…` xuất hiện khi job đang chạy. Đây là trạng thái local, không tạo thêm lượt gọi model hay token.

Mặc định chỉ một agent chạy mỗi lần. Có thể đặt `MAX_ACTIVE_RUNS=2` trong `.env` rồi khởi động lại Compose. Các vòng giao việc tự động bị giới hạn độ sâu để tránh lặp vô tận. Khi mất kết nối hoặc khởi động lại giữa một lượt, task được đánh dấu `interrupted` để bạn xem trước khi tiếp tục.

## Dữ liệu

- PostgreSQL trong volume `postgres-data`: chat, task, trạng thái và ánh xạ phiên.
- Codex trong volume `codex-state`: đăng nhập và lịch sử phiên. Chỉ container `runtime` nhận volume này; nó không có mật khẩu PostgreSQL hoặc Docker socket.
- `game-workspace/`: Markdown, code game và các artifact do agent tạo. Thư mục này được mount vào `web`, `worker` và `runtime` để xem, điều phối và thực thi công việc.

Sao lưu cả ba nơi để phục hồi đầy đủ. Dừng ứng dụng bằng `docker compose down` (không thêm `-v` nếu muốn giữ dữ liệu).

## Giới hạn hiện tại

Ứng dụng dành cho một người trên máy local. Luồng Codex dùng `codex exec --json` và `codex exec resume`; nó hiển thị kết quả khi lượt hoàn thành. Codex chạy với quyền ghi trong container `runtime` vì sandbox lồng trong Docker Desktop không tạo được user namespace; container này chỉ được mount `game-workspace` và `codex-state`. Model khả dụng và mức sử dụng tùy tài khoản ChatGPT Plus. Ứng dụng không tự chuyển sang API trả phí. Với Unity/Unreal hoặc build cần GPU/Windows, cần bổ sung runner chuyên biệt.
