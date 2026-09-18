-- ---------------------------------------------------------------------------
-- The discovery workflow: search a community platform (OpenLabs) for posts,
-- discussions and projects, and turn what it finds into open questions.
--
-- Discovered community writing raises questions but never becomes evidence,
-- so this adds no new knowledge tables — only a task type to run it under.
-- ---------------------------------------------------------------------------
alter table tasks drop constraint if exists tasks_type_check;
alter table tasks add constraint tasks_type_check
  check (type in ('research', 'comment_reply', 'regenerate_draft', 'discover'));
