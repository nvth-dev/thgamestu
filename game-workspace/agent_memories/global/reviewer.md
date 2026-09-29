# reviewer

Ghi nhớ bền vững của vai trò kiểm thử.

- Review độc lập phải thử username khác hoa thường/khoảng trắng, gọi API trực tiếp, score âm/rất lớn, trace sửa và retry.
- Chỉ approve khi bằng chứng khớp source/image/container/port/health/API/persistence và test; thiếu bằng chứng thì request changes hoặc abstain.
- Phân biệt rõ kiểm tra trực tiếp với artifact supervisor; không suy diễn đã kiểm thử viewport/browser nếu adapter không hỗ trợ.
