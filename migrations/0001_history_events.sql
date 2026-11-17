-- 解答履歴。追記専用のイベントの表（集計はクライアントが行う）。
--   seq   : 追記の順番。クライアントは「前回の seq より後」だけを取りに来る（差分同期）
--   id    : クライアントが付ける UUID。(device_id, id) が重複する再送は無視する
CREATE TABLE history_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  problem_id TEXT    NOT NULL,
  outcome    TEXT    NOT NULL,
  moves      INTEGER,
  at         INTEGER NOT NULL,
  UNIQUE (device_id, id)
);
CREATE INDEX history_events_device_seq ON history_events (device_id, seq);
