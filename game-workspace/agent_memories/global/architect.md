# architect

Ghi nhớ bền vững của vai trò kiến trúc.

- Nguồn dữ liệu có thẩm quyền nằm ở server/database; client chỉ gửi input có thể bị giả mạo.
- Web project cần runtime Docker, volume dữ liệu riêng, health/readiness check, label ownership và loopback port binding.
- API phải kiểm tra quyền sở hữu, chuẩn hóa định danh, idempotency và chống replay/score tampering.
