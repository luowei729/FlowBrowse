# FlowBrowse WebTransport 服务模块定义
# 说明：quic-go 与 webtransport-go 版本需匹配（二者由同一组织维护）。
#       install.sh 会在服务器上执行 `go mod tidy` 自动解析并生成 go.sum，
#       因此这里只声明直接依赖，不硬写 go.sum，避免因平台差异导致构建失败。
module flowbrowse-wt

go 1.24

require (
	github.com/quic-go/quic-go v0.54.0
	github.com/quic-go/webtransport-go v0.9.0
)
