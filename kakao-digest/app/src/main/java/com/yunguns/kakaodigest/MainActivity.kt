package com.yunguns.kakaodigest

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.Calendar

class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var claudeKey: EditText
    private lateinit var model: EditText
    private lateinit var kakaoKey: EditText
    private lateinit var kakaoSecret: EditText
    private lateinit var redirect: EditText
    private lateinit var time: EditText
    private lateinit var excluded: EditText
    private lateinit var autoDismiss: CheckBox
    private lateinit var keep: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(16)
            setPadding(pad, pad, pad, pad)
        }

        status = TextView(this).apply { textSize = 14f }
        root.addView(section("상태"))
        root.addView(status)
        root.addView(button("알림 접근 권한 설정 열기") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })
        root.addView(button("배터리 최적화 제외 요청") { requestIgnoreBattery() })
        root.addView(button("카카오톡 알림 설정 열기 (무음·숨김으로)") {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, KakaoListenerService.KAKAO_PACKAGE))
        })

        root.addView(section("Claude"))
        claudeKey = field(root, "Claude API 키", prefs.claudeApiKey, secret = true)
        model = field(root, "모델", prefs.claudeModel)

        root.addView(section("카카오 (나에게 보내기)"))
        kakaoKey = field(root, "REST API 키", prefs.kakaoRestKey, secret = true)
        kakaoSecret = field(root, "Client Secret (사용 시에만)", prefs.kakaoClientSecret, secret = true)
        redirect = field(root, "Redirect URI (카카오 개발자 콘솔에 등록한 값)", prefs.kakaoRedirectUri)
        root.addView(button("카카오 로그인 (저장 후 진행)") {
            save()
            if (prefs.kakaoRestKey.isBlank()) toast("REST API 키를 먼저 입력하세요")
            else startActivity(Intent(this, KakaoLoginActivity::class.java))
        })

        root.addView(section("요약"))
        time = field(root, "매일 보낼 시각 (HH:mm)", "%02d:%02d".format(prefs.digestHour, prefs.digestMinute))
        excluded = field(root, "요약에서 뺄 방 (한 줄에 하나)", prefs.excludedRoomsRaw, multiline = true)
        autoDismiss = CheckBox(this).apply {
            text = "수집 후 카톡 알림을 알림창에서 자동 삭제"
            isChecked = prefs.autoDismiss
        }
        root.addView(autoDismiss)
        keep = field(root, "자동 삭제하지 않을 방 (한 줄에 하나)", prefs.keepRoomsRaw, multiline = true)

        root.addView(button("저장") { save(); DigestWorker.schedule(this, reset = true); toast("저장했습니다"); refresh() })
        root.addView(button("지금 요약 보내기 (테스트)") {
            save()
            DigestWorker.runNow(this)
            toast("요약을 시작했습니다. 잠시 뒤 카톡을 확인하세요.")
        })

        setContentView(ScrollView(this).apply { addView(root) })
        DigestWorker.schedule(this, reset = false)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    @SuppressLint("SetTextI18n")
    private fun refresh() {
        val listenerOn = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
            ?.contains(ComponentName(this, KakaoListenerService::class.java).flattenToString()) == true
        val pm = getSystemService(PowerManager::class.java)
        val batteryOk = pm.isIgnoringBatteryOptimizations(packageName)
        val kakaoLogin = prefs.kakaoRefreshToken.isNotBlank()

        val todayStart = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        val rooms = MessageStore.get(this).roomCountsSince(todayStart)

        status.text = buildString {
            appendLine("알림 접근 권한: " + if (listenerOn) "✅ 켜짐" else "❌ 꺼짐 (아래 버튼으로 켜세요)")
            appendLine("배터리 최적화 제외: " + if (batteryOk) "✅" else "⚠️ 아니오 (예약 실행이 늦어질 수 있음)")
            appendLine("카카오 로그인: " + if (kakaoLogin) "✅" else "❌ 필요")
            appendLine("마지막 실행: " + prefs.lastResult.ifBlank { "없음" })
            appendLine()
            appendLine("오늘 수집: 방 ${rooms.size}개, 메시지 ${rooms.sumOf { it.second }}개")
            rooms.take(30).forEach { (room, count) -> appendLine("  · $room ($count)") }
        }
    }

    private fun save() {
        prefs.claudeApiKey = claudeKey.text.toString().trim()
        prefs.claudeModel = model.text.toString().trim().ifBlank { Prefs.DEFAULT_MODEL }
        prefs.kakaoRestKey = kakaoKey.text.toString().trim()
        prefs.kakaoClientSecret = kakaoSecret.text.toString().trim()
        prefs.kakaoRedirectUri = redirect.text.toString().trim().ifBlank { Prefs.DEFAULT_REDIRECT }
        val parts = time.text.toString().trim().split(":")
        val h = parts.getOrNull(0)?.toIntOrNull()
        val m = parts.getOrNull(1)?.toIntOrNull() ?: 0
        if (h != null && h in 0..23 && m in 0..59) {
            prefs.digestHour = h; prefs.digestMinute = m
        } else {
            toast("시각은 23:00 형식으로 입력하세요")
        }
        prefs.excludedRoomsRaw = excluded.text.toString()
        prefs.autoDismiss = autoDismiss.isChecked
        prefs.keepRoomsRaw = keep.text.toString()
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBattery() {
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }

    private fun section(title: String) = TextView(this).apply {
        text = title
        textSize = 18f
        setPadding(0, dp(20), 0, dp(6))
    }

    private fun field(root: LinearLayout, label: String, value: String, secret: Boolean = false, multiline: Boolean = false): EditText {
        root.addView(TextView(this).apply { text = label; textSize = 13f })
        return EditText(this).apply {
            setText(value)
            inputType = when {
                secret -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                multiline -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                else -> InputType.TYPE_CLASS_TEXT
            }
            if (multiline) minLines = 2
            root.addView(this)
        }
    }

    private fun button(label: String, onClick: (View) -> Unit) = Button(this).apply {
        text = label
        setOnClickListener(onClick)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
