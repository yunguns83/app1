package com.yunguns.kakaodigest

import android.content.Context
import android.content.SharedPreferences

/** 앱 설정과 토큰. 앱 전용 저장소에만 저장되며 백업되지 않는다(allowBackup=false). */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var claudeApiKey: String by str("claude_api_key")
    var claudeModel: String by str("claude_model", DEFAULT_MODEL)
    var kakaoRestKey: String by str("kakao_rest_key")
    var kakaoClientSecret: String by str("kakao_client_secret")
    var kakaoRedirectUri: String by str("kakao_redirect_uri", DEFAULT_REDIRECT)

    var kakaoAccessToken: String by str("kakao_access_token")
    var kakaoRefreshToken: String by str("kakao_refresh_token")
    var kakaoAccessExpiresAt: Long by long("kakao_access_expires_at")

    var digestHour: Int by int("digest_hour", 23)
    var digestMinute: Int by int("digest_minute", 0)

    /** 요약에서 뺄 방 이름 (줄바꿈 또는 쉼표로 구분) */
    var excludedRoomsRaw: String by str("excluded_rooms")

    /** 수집한 뒤 카톡 알림을 알림창에서 지울지 */
    var autoDismiss: Boolean by bool("auto_dismiss", false)

    /** 자동 삭제하지 않고 알림창에 남겨 둘 방 */
    var keepRoomsRaw: String by str("keep_rooms")

    /** 마지막으로 요약을 보낸 시각. 다음 요약은 이 이후 메시지만 다룬다. */
    var lastDigestAt: Long by long("last_digest_at")
    var lastResult: String by str("last_result")

    val excludedRooms: Set<String> get() = parseList(excludedRoomsRaw)
    val keepRooms: Set<String> get() = parseList(keepRoomsRaw)

    private fun parseList(raw: String): Set<String> =
        raw.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()

    private fun str(key: String, def: String = "") = object : kotlin.properties.ReadWriteProperty<Any?, String> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>) = sp.getString(key, def) ?: def
        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: String) {
            sp.edit().putString(key, value).apply()
        }
    }

    private fun long(key: String, def: Long = 0L) = object : kotlin.properties.ReadWriteProperty<Any?, Long> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>) = sp.getLong(key, def)
        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: Long) {
            sp.edit().putLong(key, value).apply()
        }
    }

    private fun int(key: String, def: Int) = object : kotlin.properties.ReadWriteProperty<Any?, Int> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>) = sp.getInt(key, def)
        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: Int) {
            sp.edit().putInt(key, value).apply()
        }
    }

    private fun bool(key: String, def: Boolean) = object : kotlin.properties.ReadWriteProperty<Any?, Boolean> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>) = sp.getBoolean(key, def)
        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: Boolean) {
            sp.edit().putBoolean(key, value).apply()
        }
    }

    companion object {
        const val DEFAULT_MODEL = "claude-opus-5-5"
        const val DEFAULT_REDIRECT = "https://localhost/kakao-digest"
    }
}
