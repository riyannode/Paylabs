-- PayLabs additional tables: learning paths, path items, agent actions
-- Plus RLS policies for existing tables

-- Learning paths: AI Tutor proposed paths
CREATE TABLE IF NOT EXISTS paylabs_learning_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet text NOT NULL,
  goal text NOT NULL,
  budget_usdc numeric(18,6) NOT NULL,
  estimated_total_usdc numeric(18,6) NOT NULL,
  agent_reasoning_summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'active', 'completed', 'cancelled')),
  created_by_agent_id text,
  created_at timestamptz DEFAULT now()
);

-- Learning path items: lessons in a path
CREATE TABLE IF NOT EXISTS paylabs_learning_path_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path_id uuid NOT NULL REFERENCES paylabs_learning_paths(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES paylabs_lessons(id),
  order_index int NOT NULL,
  reason text NOT NULL DEFAULT '',
  expected_value text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'unlocked', 'completed', 'skipped')),
  created_at timestamptz DEFAULT now()
);

-- Agent actions: audit trail for agent decisions
CREATE TABLE IF NOT EXISTS paylabs_agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet text NOT NULL,
  agent_id text,
  action_type text NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'blocked_by_policy', 'failed')),
  policy_decision jsonb,
  payment_id text,
  created_at timestamptz DEFAULT now()
);

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_paths_user_status
  ON paylabs_learning_paths(user_wallet, status);

CREATE INDEX IF NOT EXISTS idx_path_items_path
  ON paylabs_learning_path_items(path_id);

CREATE INDEX IF NOT EXISTS idx_agent_actions_user_created
  ON paylabs_agent_actions(user_wallet, created_at DESC);

-- RLS: Enable on new tables
ALTER TABLE paylabs_learning_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE paylabs_learning_path_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE paylabs_agent_actions ENABLE ROW LEVEL SECURITY;

-- RLS policies: server-only write, no direct client access
-- (PayLabs uses service role key for all writes; anon key reads nothing)

-- paylabs_sources: public read for published lesson metadata
CREATE POLICY "Public can read sources"
  ON paylabs_sources FOR SELECT
  USING (true);

-- paylabs_creators: public read
CREATE POLICY "Public can read creators"
  ON paylabs_creators FOR SELECT
  USING (true);

-- paylabs_lessons: public read for published lessons
CREATE POLICY "Public can read published lessons"
  ON paylabs_lessons FOR SELECT
  USING (is_published = true);

-- paylabs_unlocks: no public access (server-only)
-- paylabs_completions: no public access (server-only)
-- paylabs_payout_receipts: no public access (server-only)
-- paylabs_learning_paths: no public access (server-only)
-- paylabs_learning_path_items: no public access (server-only)
-- paylabs_agent_actions: no public access (server-only)
