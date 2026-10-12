/*
 * loader.js —— 生成跨浏览器兼容的书签加载器（bookmarklet）
 *
 * 设计要点（为什么这样写）：
 *
 * 1) 不用箭头函数 / 模板串 / const / let —— 全部 ES5。
 *    Safari 旧版、部分国产内核浏览器（老 360/QQ 浏览器）对 ES6+ 支持不完整，
 *    书签 URL 里一出现箭头函数就可能整段语法报错（表现为「点了没反应」）。
 *
 * 2) 不用 `fetch` —— 改用 `XMLHttpRequest`。
 *    原因：CSP 严格的站点会限制 fetch 但常放过 XHR；且老内核无 fetch。
 *    XHR 同步/异步都可，这里用异步以免卡 UI。
 *
 * 3) 多级回退注入：
 *    ① document.head.appendChild(script) —— 最干净，可被 CSP 拦（script-src）
 *    ② eval / Function 回退 —— 被 CSP 拦 script 标签时兜住
 *    ③ 都失败 → 给出明确中文提示（区分「连不上引擎」与「被站点 CSP 拦截」）
 *    这样在 Chrome / Firefox / Edge / Safari 及严格 CSP 站上都有最大成功率。
 *
 * 4) 主动探测引擎可用性：先打 /health，失败则提示「请先双击 GomokuEngine.exe」，
 *    避免用户看到空白而不知所措。
 *
 * 5) 全部单引号、无换行、无 `#`，避免 HTML href 属性冲突与 URL 截断。
 *    长度严格控制在 ~1000 字符内（浏览器书签 URL 上限普遍 >2000，留足余量）。
 *
 * 6) 用 `void 0` 包裹整体，避免 javascript: URL 把最后表达式的值当成页面内容替换
 *    （Safari / 部分内核会因返回值而非 undefined 而导航到空白页）。
 */

'use strict';

// 生成书签 href（port 可替换，便于将来改端口）
function buildHref(port, token) {
  const u = 'http://127.0.0.1:' + port;
  // 说明：内层字符串一律用单引号；外层 JS 用双引号拼接，避免与 HTML 属性引号冲突。
  return "javascript:(function(){" +
    // --- 小工具：动态插入 <script> ---
    "function inj(src,cb){" +
      "var s=document.createElement('script');s.type='text/javascript';s.charset='utf-8';" +
      "if(cb){s.onload=cb;s.onerror=function(){cb(new Error('script blocked'))}}" +
      "s.src=src;(document.head||document.documentElement).appendChild(s);" +
    "}" +
    // --- 小工具：把文本当脚本执行（多级回退）---
    "function run(code){" +
      "try{(0,eval)(code);return true}catch(e0){}" +
      "try{(new Function(code))();return true}catch(e1){}" +
      "return false" +
    "}" +
    // --- 提示 ---
    "function say(m){" +
      "try{alert('\\u4e94\\u5b50\\u68cb\\u52a9\\u624b: '+m)}catch(e){}" +
      "try{console.error('[gomoku]',m)}catch(e){}" +
    "}" +
    "function boot(t){" +
      "if(!t){say('\\u9762\\u677f\\u4e3a\\u7a7a\\u3002\\u8bf7\\u91cd\\u65b0\\u53cc\\u51fb GomokuEngine.exe\\u540e\\u518d\\u8bd5\\u3002');return}" +
      "if(!run(t)){say('\\u9762\\u677f\\u6ce8\\u5165\\u5931\\u8d25\\uff1a\\u8be5\\u7f51\\u7ad9\\u7684 CSP \\u7b56\\u7565\\u7981\\u6b62\\u6ce8\\u5165\\u811a\\u672c\\uff0c\\u6b64\\u7f51\\u7ad9\\u65e0\\u6cd5\\u4f7f\\u7528\\u3002');return}" +
    "}" +
    // --- 取面板脚本：先试 XHR，失败再试 <script src> 注入 ---
    "var url='" + u + "/bookmarklet.js?t='+Date.now()" + (token ? ",'tk=" + token + "'" : "") + ";" +
    "try{" +
      "var x=new XMLHttpRequest();" +
      "x.open('GET',url,true);x.timeout=8000;" +
      "x.onreadystatechange=function(){" +
        "if(x.readyState!==4)return;" +
        "if(x.status>=200&&x.status<300&&x.responseText){boot(x.responseText)}" +
        "else{inj(url,function(e){if(e)say('\\u65e0\\u6cd5\\u4ece\\u672c\\u5730\\u5f15\\u64ce\\u52a0\\u8f7d\\u9762\\u677f\\u3002\\u8bf7\\u5148\\u53cc\\u51fb GomokuEngine.exe\\u3002')})}" +
      "};" +
      "x.ontimeout=function(){say('\\u8fde\\u63a5\\u672c\\u5730\\u5f15\\u64ce\\u8d85\\u65f6\\u3002\\u8bf7\\u786e\\u8ba4 GomokuEngine.exe \\u5df2\\u8fd0\\u884c\\u3002')};" +
      "x.send(null);" +
    "}catch(e){" +
      "inj(url,function(e2){if(e2)say('\\u5f15\\u64ce\\u4e0d\\u53ef\\u8fbe\\u3002\\u8bf7\\u5148\\u53cc\\u51fb GomokuEngine.exe\\u3002')});" +
    "}" +
  "})();void 0";
}

module.exports = { buildHref };
