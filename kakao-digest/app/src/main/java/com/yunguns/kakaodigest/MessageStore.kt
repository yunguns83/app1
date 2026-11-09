package com.yunguns.kakaodigest

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class ChatMessage(
    val room: String,
    val sender: String,
    val text: String,
    val time: Long,
)

/**
 * 수집한 메시지를 기기 안의 SQLite에 저장한다.
 * 카톡은 같은 방 알림을 갱신할 때마다 이전 메시지를 다시 담아 보내므로
 * (방, 보낸이, 시각, 내용) 유니크 인덱스로 중복을 거른다.
 */
class MessageStore private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "messages.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room TEXT NOT NULL,
                sender TEXT NOT NULL,
                text TEXT NOT NULL,
                time INTEGER NOT NULL
            )"""
        )
        db.execSQL("CREATE UNIQUE INDEX ux_msg ON messages(room, sender, time, text)")
        db.execSQL("CREATE INDEX ix_time ON messages(time)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    /** @return 새로 저장된 개수 */
    fun insertAll(messages: List<ChatMessage>): Int {
        var added = 0
        writableDatabase.run {
            beginTransaction()
            try {
                for (m in messages) {
                    val cv = ContentValues().apply {
                        put("room", m.room)
                        put("sender", m.sender)
                        put("text", m.text)
                        put("time", m.time)
                    }
                    if (insertWithOnConflict("messages", null, cv, SQLiteDatabase.CONFLICT_IGNORE) != -1L) added++
                }
                setTransactionSuccessful()
            } finally {
                endTransaction()
            }
        }
        return added
    }

    /** (from, to] 구간 메시지를 방·시간 순으로 */
    fun between(from: Long, to: Long): List<ChatMessage> {
        val out = ArrayList<ChatMessage>()
        readableDatabase.rawQuery(
            "SELECT room, sender, text, time FROM messages WHERE time > ? AND time <= ? ORDER BY room, time",
            arrayOf(from.toString(), to.toString())
        ).use { c ->
            while (c.moveToNext()) out += ChatMessage(c.getString(0), c.getString(1), c.getString(2), c.getLong(3))
        }
        return out
    }

    /** 방 이름별 메시지 수 (설정 화면 표시용) */
    fun roomCountsSince(from: Long): List<Pair<String, Int>> {
        val out = ArrayList<Pair<String, Int>>()
        readableDatabase.rawQuery(
            "SELECT room, COUNT(*) FROM messages WHERE time > ? GROUP BY room ORDER BY COUNT(*) DESC",
            arrayOf(from.toString())
        ).use { c ->
            while (c.moveToNext()) out += c.getString(0) to c.getInt(1)
        }
        return out
    }

    fun deleteOlderThan(time: Long) {
        writableDatabase.delete("messages", "time < ?", arrayOf(time.toString()))
    }

    companion object {
        @Volatile private var instance: MessageStore? = null
        fun get(context: Context): MessageStore =
            instance ?: synchronized(this) { instance ?: MessageStore(context).also { instance = it } }
    }
}
