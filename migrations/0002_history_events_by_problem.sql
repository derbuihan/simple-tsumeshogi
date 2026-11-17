-- 履歴は読むときに SQL で問題ごとに集計する（GROUP BY problem_id）。差分同期はやめたので seq の索引は不要。
DROP INDEX history_events_device_seq;
CREATE INDEX history_events_device_problem ON history_events (device_id, problem_id);
