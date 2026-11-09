package com.yunguns.kakaodigest

import android.net.Uri
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class KakaoApiException(val code: Int, message: String) : IOException(message)

/**
 * 카카오 로그인(REST) 토큰 관리와 "나에게 보내기" 메시지 전송.
 * 필요 권한(동의항목): talk_message (카카오톡 메시지 전송)
 */
class KakaoApi(private val prefs: Prefs) {

    fun authorizeUrl(): String =
        Uri.parse("https://kauth.kakao.com/oauth/authorize").buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("client_id", prefs.kakaoRestKey)
            .appendQueryParameter("redirect_uri", prefs.kakaoRedirectUri)
            .appendQueryParameter("scope", "talk_message")
            .build().toString()

    /** 로그인 후 받은 인가 코드를 토큰으로 바꾼다. */
    fun exchangeCode(code: String) {
        val params = mutableMapOf(
            "grant_type" to "authorization_code",
            "client_id" to prefs.kakaoRestKey,
            "redirect_uri" to prefs.kakaoRedirectUri,
            "code" to code,
        )
        if (prefs.kakaoClientSecret.isNotBlank()) params["client_secret"] = prefs.kakaoClientSecret
        saveTokens(JSONObject(post("https://kauth.kakao.com/oauth/token", params, null)))
    }

    private fun refresh() {
        if (prefs.kakaoRefreshToken.isBlank()) throw KakaoApiException(401, "카카오 로그인이 필요합니다")
        val params = mutableMapOf(
            "grant_type" to "refresh_token",
            "client_id" to prefs.kakaoRestKey,
            "refresh_token" to prefs.kakaoRefreshToken,
        )
        if (prefs.kakaoClientSecret.isNotBlank()) params["client_secret"] = prefs.kakaoClientSecret
        saveTokens(JSONObject(post("https://kauth.kakao.com/oauth/token", params, null)))
    }

    private fun saveTokens(json: JSONObject) {
        prefs.kakaoAccessToken = json.getString("access_token")
        prefs.kakaoAccessExpiresAt = System.currentTimeMillis() + json.optLong("expires_in", 0) * 1000
        // 리프레시 토큰은 만료가 가까울 때만 새로 내려온다.
        json.optString("refresh_token").takeIf { it.isNotEmpty() }?.let { prefs.kakaoRefreshToken = it }
    }

    private fun validAccessToken(): String {
        if (prefs.kakaoAccessToken.isBlank() ||
            System.currentTimeMillis() > prefs.kakaoAccessExpiresAt - 5 * 60_000
        ) refresh()
        return prefs.kakaoAccessToken
    }

    /** 텍스트를 200자 이하 조각으로 나눠 나에게 보낸다. */
    fun sendToMe(header: String, body: String) {
        val chunks = splitForKakao(header, body)
        for (chunk in chunks) sendText(chunk)
    }

    private fun sendText(text: String) {
        val template = JSONObject()
            .put("object_type", "text")
            .put("text", text)
            .put("link", JSONObject()
                .put("web_url", "https://developers.kakao.com")
                .put("mobile_web_url", "https://developers.kakao.com"))
        val params = mapOf("template_object" to template.toString())
        val url = "https://kapi.kakao.com/v2/api/talk/memo/default/send"
        try {
            post(url, params, validAccessToken())
        } catch (e: KakaoApiException) {
            if (e.code != 401) throw e
            refresh()
            post(url, params, prefs.kakaoAccessToken)
        }
    }

    private fun post(url: String, params: Map<String, String>, bearer: String?): String {
        val body = params.entries.joinToString("&") {
            URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        }
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer $bearer")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw KakaoApiException(code, "카카오 API 오류 $code: $text")
            return text
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        /** 카카오 텍스트 템플릿의 text 최대 길이 */
        const val MAX_TEXT = 200

        /** 줄 단위로 묶어 200자 이하 조각을 만들고, 각 조각 앞에 "[헤더 i/n]"을 붙인다. */
        fun splitForKakao(header: String, body: String): List<String> {
            val prefixBudget = header.length + 10 // "[header 12/34]\n"
            val budget = MAX_TEXT - prefixBudget
            require(budget > 40) { "헤더가 너무 깁니다" }

            val lines = body.lines().map { it.trimEnd() }.filter { it.isNotEmpty() }
                .flatMap { line -> line.chunked(budget) }
            val parts = ArrayList<String>()
            val cur = StringBuilder()
            for (line in lines) {
                // 방 제목(■) 줄은 가능하면 새 조각에서 시작한다.
                val startsSection = line.startsWith("■") || line.startsWith("📌")
                val needed = (if (cur.isEmpty()) 0 else 1) + line.length
                if (cur.isNotEmpty() && (cur.length + needed > budget || (startsSection && cur.length > budget / 2))) {
                    parts += cur.toString(); cur.clear()
                }
                if (cur.isNotEmpty()) cur.append('\n')
                cur.append(line)
            }
            if (cur.isNotEmpty()) parts += cur.toString()
            if (parts.isEmpty()) parts += "(내용 없음)"
            return parts.mapIndexed { i, p -> "[$header ${i + 1}/${parts.size}]\n$p" }
        }
    }
}
