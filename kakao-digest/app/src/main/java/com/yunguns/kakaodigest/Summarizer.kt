package com.yunguns.kakaodigest

import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.models.beta.messages.BetaStopReason
import com.anthropic.models.beta.messages.MessageCreateParams
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 하루치 카톡 메시지를 Claude로 요약한다. */
class Summarizer(private val apiKey: String, private val model: String) {

    fun summarize(messages: List<ChatMessage>, from: Long, to: Long): String {
        val client = AnthropicOkHttpClient.builder().apiKey(apiKey).build()
        try {
            val params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(16000L)
                .system(SYSTEM_PROMPT)
                .addUserMessage(buildTranscript(messages, from, to))
                // 안전 분류기가 요청을 거절하면 서버가 알맞은 다른 모델로 자동 재시도한다.
                .addBeta("server-side-fallback-2026-07-01")
                .putAdditionalBodyProperty("fallbacks", JsonValue.from("default"))
                .build()

            val response = client.beta().messages().create(params)
            val stop = response.stopReason().orElse(null)
            val text = response.content()
                .mapNotNull { block -> block.text().map { it.text() }.orElse(null) }
                .joinToString("")
                .trim()

            if (stop == BetaStopReason.REFUSAL) throw IllegalStateException("Claude가 요약을 거절했습니다 (refusal)")
            if (text.isEmpty()) throw IllegalStateException("Claude 응답이 비어 있습니다 (stop_reason=$stop)")
            return text
        } finally {
            client.close()
        }
    }

    private fun buildTranscript(messages: List<ChatMessage>, from: Long, to: Long): String {
        val range = SimpleDateFormat("M/d HH:mm", Locale.KOREA)
        val time = SimpleDateFormat("M/d HH:mm", Locale.KOREA)
        val sb = StringBuilder()
        sb.append("기간: ").append(range.format(Date(from))).append(" ~ ").append(range.format(Date(to))).append('\n')
        sb.append("방 수: ").append(messages.map { it.room }.distinct().size)
            .append(", 메시지 수: ").append(messages.size).append("\n\n")
        for ((room, list) in messages.groupBy { it.room }) {
            sb.append("<room name=\"").append(room.replace("\"", "'")).append("\">\n")
            for (m in list) {
                sb.append('[').append(time.format(Date(m.time))).append("] ")
                    .append(m.sender).append(": ")
                    .append(m.text.replace('\n', ' '))
                    .append('\n')
            }
            sb.append("</room>\n\n")
        }
        return sb.toString()
    }

    companion object {
        private val SYSTEM_PROMPT = """
            너는 사용자의 카카오톡 대화를 하루 단위로 정리해 주는 비서다.
            입력은 사용자가 받은 카톡 메시지를 채팅방(<room>)별로 모은 것이다.
            요약은 카카오톡 "나에게 보내기"로 전달되며, 한 메시지에 약 200자만 들어가서 앱이 줄 단위로 나눠 보낸다.

            출력 규칙:
            - 마크다운(#, **, 표) 없이 일반 텍스트로만 쓴다.
            - 첫 줄: 오늘 하루를 한 문장으로 요약한다.
            - 그다음 "📌 챙길 일" 아래에 사용자가 직접 답하거나 해야 할 일, 약속·일정·마감·금액을 "- "로 적는다. 없으면 이 부분을 생략한다.
            - 그다음 방마다 "■ 방이름" 줄을 쓰고, 그 아래에 핵심 내용 1~3줄을 "- "로 적는다.
            - 중요한 방(할 일·일정이 있는 방, 대화가 많은 방)을 먼저 쓴다. 인사·이모티콘·잡담뿐인 방은 마지막에 "기타: 방이름, 방이름 (잡담)" 한 줄로 묶는다.
            - 한 줄은 120자를 넘기지 않는다. 사람 이름과 날짜·시간·금액은 원문 그대로 쓴다.
            - 메시지에 없는 내용을 추측해서 덧붙이지 않는다.
        """.trimIndent()
    }
}
