// gbhttp.h —— 极简 HTTP/1.1 服务（零第三方依赖，winsock2）
// =====================================================================
// 只实现这两个本地服务真正用到的部分：请求行 / 头 / Content-Length 体、
// keep-alive、CORS 预检、JSON 响应。刻意不做 chunked / 压缩 / 多路由。
#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace gb {

struct HttpRequest {
    std::string method;
    std::string path;
    std::string body;
    std::vector<std::pair<std::string, std::string>> headers;

    std::string header(const std::string& k) const;
};

struct HttpResponse {
    int status = 200;
    std::string contentType = "application/json";
    std::string body;
    std::vector<std::pair<std::string, std::string>> extraHeaders;
};

using HttpHandler = std::function<HttpResponse(const HttpRequest&)>;

/** 启动监听 127.0.0.1:port；失败时 err 带原因。非阻塞（内部线程 accept）。 */
bool startHttpServer(int port, HttpHandler handler, std::string& err);

}  // namespace gb
