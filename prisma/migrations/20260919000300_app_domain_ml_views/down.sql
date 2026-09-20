-- Reverse of 20260919000300_app_domain_ml_views. Safe while empty.

DROP VIEW IF EXISTS ml.v_growth_labels;
DROP VIEW IF EXISTS ml.v_behaviour_sequences;
DROP VIEW IF EXISTS ml.v_grading_examples;
DROP VIEW IF EXISTS ml.v_consented_learner;
DROP TABLE IF EXISTS ml.training_export_run;

DROP TABLE IF EXISTS app.learning_path_step;
DROP TABLE IF EXISTS app.skill_state_history;
DROP TABLE IF EXISTS app.skill_state;
DROP VIEW IF EXISTS app.score_effective;
DROP TABLE IF EXISTS app.teacher_correction;
DROP TABLE IF EXISTS app.ai_verdict;
DROP TABLE IF EXISTS app.submission_draft;
DROP TABLE IF EXISTS app.submission;
DROP TABLE IF EXISTS app.attempt;
DROP TABLE IF EXISTS app.skill;
DROP TABLE IF EXISTS app.exercise_item;
DROP TABLE IF EXISTS app.rubric_version;
DROP TABLE IF EXISTS app.rubric;
DROP TABLE IF EXISTS app.lesson;
DROP TABLE IF EXISTS app.course;
