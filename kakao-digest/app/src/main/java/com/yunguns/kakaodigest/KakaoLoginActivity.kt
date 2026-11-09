package com.yunguns.kakaodigest

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

/** 카카오 로그인 화면을 띄우고, redirect URI로 돌아오는 인가 코드를 가로채 토큰으로 바꾼다. */
class KakaoLoginActivity : Activity() {

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        val api = KakaoApi(prefs)
        val web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(prefs.kakaoRedirectUri)) {
                    handleRedirect(request.url, api)
                    return true
                }
                // "카카오톡으로 로그인"(intent://, kakaotalk://)은 WebView에서 열 수 없으므로 막는다.
                // 화면의 카카오계정(이메일·전화번호) 로그인을 사용하면 된다.
                return request.url.scheme != "http" && request.url.scheme != "https"
            }
        }
        web.loadUrl(api.authorizeUrl())
    }

    private fun handleRedirect(uri: Uri, api: KakaoApi) {
        val code = uri.getQueryParameter("code")
        if (code == null) {
            toast("로그인 실패: " + (uri.getQueryParameter("error_description") ?: uri.getQueryParameter("error")))
            finish()
            return
        }
        Thread {
            val result = runCatching { api.exchangeCode(code) }
            runOnUiThread {
                toast(result.fold({ "카카오 로그인 완료" }, { "토큰 발급 실패: ${it.message}" }))
                setResult(if (result.isSuccess) RESULT_OK else RESULT_CANCELED)
                finish()
            }
        }.start()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
