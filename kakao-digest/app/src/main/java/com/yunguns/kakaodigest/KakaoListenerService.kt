package com.yunguns.kakaodigest

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * 카카오톡 알림을 읽어 메시지를 저장한다.
 *
 * 카톡에서 "알림 끔"으로 설정한 방은 알림이 아예 만들어지지 않아 읽을 수 없다.
 * 그래서 카톡 방 알림은 켜 두고, 안드로이드 설정에서 카톡 알림을 무음·숨김으로 바꿔 쓰는 방식을 전제로 한다.
 */
class KakaoListenerService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != KAKAO_PACKAGE) return
        val n = sbn.notification ?: return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val messages = try {
            parse(sbn)
        } catch (e: Exception) {
            Log.w(TAG, "알림 파싱 실패", e)
            emptyList()
        }
        if (messages.isEmpty()) return

        MessageStore.get(this).insertAll(messages)

        val prefs = Prefs(this)
        if (prefs.autoDismiss && messages.none { it.room in prefs.keepRooms }) {
            cancelNotification(sbn.key)
        }
    }

    private fun parse(sbn: StatusBarNotification): List<ChatMessage> {
        val n = sbn.notification
        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()

        // 최신 카톡은 MessagingStyle 알림을 쓰며, 그 안에 메시지별 보낸이·시각이 들어 있다.
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        if (style != null && style.messages.isNotEmpty()) {
            val conversation = style.conversationTitle?.toString()?.trim()
            return style.messages.mapNotNull { m ->
                val text = m.text?.toString()?.trim().orEmpty()
                if (text.isEmpty()) return@mapNotNull null
                val sender = m.person?.name?.toString()?.trim()
                    ?: style.user.name?.toString()?.trim()
                    ?: "나"
                // 단톡방은 conversationTitle(또는 subText)에 방 이름이 있고, 1:1 방은 상대 이름이 곧 방 이름이다.
                val room = conversation.nonBlank() ?: subText.nonBlank() ?: title.nonBlank() ?: sender
                ChatMessage(room, sender, text, if (m.timestamp > 0) m.timestamp else sbn.postTime)
            }
        }

        // 구형 알림 형식: 제목 = 보낸이, 내용 = 메시지, subText = 방 이름(단톡방일 때)
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim().orEmpty()
        if (text.isEmpty() || title.isNullOrEmpty()) return emptyList()
        val room = subText.nonBlank() ?: title
        return listOf(ChatMessage(room, title, text, sbn.postTime))
    }

    private fun String?.nonBlank(): String? = this?.takeIf { it.isNotBlank() }

    companion object {
        const val KAKAO_PACKAGE = "com.kakao.talk"
        private const val TAG = "KakaoListener"
    }
}
