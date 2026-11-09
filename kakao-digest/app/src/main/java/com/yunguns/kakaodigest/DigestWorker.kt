package com.yunguns.kakaodigest

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/** 마지막 요약 이후 메시지를 모아 Claude로 요약하고 카톡 "나에게 보내기"로 전송한다. */
class DigestWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val store = MessageStore.get(applicationContext)
        val now = System.currentTimeMillis()
        val from = prefs.lastDigestAt.takeIf { it > 0 } ?: (now - TimeUnit.DAYS.toMillis(1))
        val stamp = SimpleDateFormat("M/d HH:mm", Locale.KOREA).format(Date(now))

        return try {
            require(prefs.claudeApiKey.isNotBlank()) { "Claude API 키가 없습니다" }
            require(prefs.kakaoRestKey.isNotBlank()) { "카카오 REST API 키가 없습니다" }

            val excluded = prefs.excludedRooms
            val messages = store.between(from, now).filter { it.room !in excluded }
            val kakao = KakaoApi(prefs)
            val header = "카톡요약 " + SimpleDateFormat("M/d", Locale.KOREA).format(Date(now))

            if (messages.isEmpty()) {
                kakao.sendToMe(header, "지난 요약 이후 수집된 메시지가 없습니다.\n(알림 접근 권한과 카톡 방 알림이 켜져 있는지 확인하세요)")
            } else {
                val summary = Summarizer(prefs.claudeApiKey, prefs.claudeModel).summarize(messages, from, now)
                kakao.sendToMe(header, summary)
            }

            prefs.lastDigestAt = now
            prefs.lastResult = "$stamp 전송 완료 (메시지 ${messages.size}개, 방 ${messages.map { it.room }.distinct().size}개)"
            store.deleteOlderThan(now - TimeUnit.DAYS.toMillis(KEEP_DAYS))
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "요약 실패", e)
            prefs.lastResult = "$stamp 실패 (시도 ${runAttemptCount + 1}회): ${e.message}"
            // 네트워크·서버 오류는 잠시 뒤 다시 시도, 설정 오류는 바로 포기
            val retryable = e is IOException && !(e is KakaoApiException && e.code in 400..499 && e.code != 401) ||
                e is com.anthropic.errors.AnthropicIoException ||
                e is com.anthropic.errors.RateLimitException ||
                e is com.anthropic.errors.InternalServerException
            if (retryable && runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    companion object {
        private const val TAG = "DigestWorker"
        private const val DAILY = "daily-digest"
        private const val NOW = "digest-now"
        private const val KEEP_DAYS = 14L

        private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** 매일 설정한 시각에 실행되도록 예약한다. reset=true면 시각 변경을 반영해 다시 예약. */
        fun schedule(context: Context, reset: Boolean) {
            val prefs = Prefs(context)
            val request = PeriodicWorkRequestBuilder<DigestWorker>(1, TimeUnit.DAYS)
                .setInitialDelay(delayUntil(prefs.digestHour, prefs.digestMinute), TimeUnit.MILLISECONDS)
                .setConstraints(network)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                DAILY,
                if (reset) ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE else ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        fun runNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<DigestWorker>().setConstraints(network).build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
        }

        private fun delayUntil(hour: Int, minute: Int): Long {
            val now = Calendar.getInstance()
            val next = (now.clone() as Calendar).apply {
                set(Calendar.HOUR_OF_DAY, hour)
                set(Calendar.MINUTE, minute)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
                if (!after(now)) add(Calendar.DAY_OF_MONTH, 1)
            }
            return next.timeInMillis - now.timeInMillis
        }
    }
}
