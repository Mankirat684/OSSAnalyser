import pg from "pg";

const { Pool } = pg;

async function syncDatabases() {
  const destUrl = process.argv[2] || process.env.RENDER_DATABASE_URL || process.env.DATABASE_URL;

  if (!destUrl) {
    console.error("\n❌ Error: Please provide your Render External Database URL.");
    console.log("Usage: npx tsx scripts/sync_postgres.ts \"<RENDER_EXTERNAL_DATABASE_URL>\"\n");
    process.exit(1);
  }

  const sourceUrl = process.env.LOCAL_DATABASE_URL || "postgresql://postgres:postgrespassword@localhost:5432/ossanalyser";

  console.log("\n==========================================================");
  console.log("  OSS Analyser: Docker Postgres -> Render Postgres Sync");
  console.log("==========================================================");
  console.log(`Source (Docker) : ${sourceUrl.replace(/:([^:@]+)@/, ":****@")}`);
  console.log(`Target (Render) : ${destUrl.replace(/:([^:@]+)@/, ":****@")}\n`);

  const sourcePool = new Pool({ connectionString: sourceUrl });
  const isDestSsl = destUrl.includes("render.com") || destUrl.includes("supabase.co") || destUrl.includes("sslmode=require");
  const destPool = new Pool({
    connectionString: destUrl,
    ssl: isDestSsl ? { rejectUnauthorized: false } : undefined
  });

  const sourceClient = await sourcePool.connect();
  const destClient = await destPool.connect();

  const startTime = Date.now();

  try {
    // 1. Sync Repositories
    console.log("Syncing 'repositories'...");
    const reposRes = await sourceClient.query(`
      SELECT id, name, root_path, owner_id, status, checkpoint_data, architecture_summary, onboarding_guide, indexed_at
      FROM repositories
    `);

    for (const r of reposRes.rows) {
      await destClient.query(
        `INSERT INTO repositories (id, name, root_path, owner_id, status, checkpoint_data, architecture_summary, onboarding_guide, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           root_path = EXCLUDED.root_path,
           status = EXCLUDED.status,
           checkpoint_data = EXCLUDED.checkpoint_data,
           architecture_summary = EXCLUDED.architecture_summary,
           onboarding_guide = EXCLUDED.onboarding_guide,
           indexed_at = EXCLUDED.indexed_at`,
        [
          r.id,
          r.name,
          r.root_path,
          r.owner_id ?? null,
          r.status ?? "completed",
          r.checkpoint_data ? JSON.stringify(r.checkpoint_data) : "{}",
          r.architecture_summary ?? null,
          r.onboarding_guide ?? null,
          r.indexed_at || new Date()
        ]
      );
    }
    console.log(`✓ Repositories: ${reposRes.rows.length} records transferred`);

    // 2. Sync Code Nodes in chunks
    console.log("Syncing 'code_nodes'...");
    const nodesRes = await sourceClient.query(`
      SELECT id, repo_id, node_type, name, file_path, start_line, end_line, start_column, end_column,
             signature, raw_code, summary, level, metadata
      FROM code_nodes
    `);

    const BATCH_SIZE = 100;
    for (let i = 0; i < nodesRes.rows.length; i += BATCH_SIZE) {
      const batch = nodesRes.rows.slice(i, i + BATCH_SIZE);
      for (const n of batch) {
        await destClient.query(
          `INSERT INTO code_nodes (
             id, repo_id, node_type, name, file_path, start_line, end_line, start_column, end_column,
             signature, raw_code, summary, level, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE SET
             repo_id = EXCLUDED.repo_id,
             node_type = EXCLUDED.node_type,
             name = EXCLUDED.name,
             file_path = EXCLUDED.file_path,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             start_column = EXCLUDED.start_column,
             end_column = EXCLUDED.end_column,
             signature = EXCLUDED.signature,
             raw_code = EXCLUDED.raw_code,
             summary = EXCLUDED.summary,
             level = EXCLUDED.level,
             metadata = EXCLUDED.metadata`,
          [
            n.id,
            n.repo_id,
            n.node_type,
            n.name,
            n.file_path,
            n.start_line ?? null,
            n.end_line ?? null,
            n.start_column ?? null,
            n.end_column ?? null,
            n.signature ?? null,
            n.raw_code ?? null,
            n.summary ?? null,
            n.level ?? 0,
            n.metadata ? JSON.stringify(n.metadata) : "{}"
          ]
        );
      }
    }
    console.log(`✓ Code Nodes: ${nodesRes.rows.length} records transferred`);

    // 3. Sync Code Edges
    console.log("Syncing 'code_edges'...");
    const edgesRes = await sourceClient.query(`
      SELECT repo_id, source_id, target_id, relation, confidence, metadata
      FROM code_edges
    `);

    for (let i = 0; i < edgesRes.rows.length; i += BATCH_SIZE) {
      const batch = edgesRes.rows.slice(i, i + BATCH_SIZE);
      for (const e of batch) {
        await destClient.query(
          `INSERT INTO code_edges (repo_id, source_id, target_id, relation, confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (repo_id, source_id, target_id, relation) DO NOTHING`,
          [
            e.repo_id,
            e.source_id,
            e.target_id,
            e.relation,
            e.confidence || "EXTRACTED",
            e.metadata ? JSON.stringify(e.metadata) : "{}"
          ]
        );
      }
    }
    console.log(`✓ Code Edges: ${edgesRes.rows.length} records transferred`);

    // 4. Sync Git Ownership
    console.log("Syncing 'git_ownership'...");
    const gitRes = await sourceClient.query(`
      SELECT repo_id, node_id, author_name, author_email, lines_authored, ownership_percentage, last_commit_date, total_commits
      FROM git_ownership
    `);

    for (let i = 0; i < gitRes.rows.length; i += BATCH_SIZE) {
      const batch = gitRes.rows.slice(i, i + BATCH_SIZE);
      for (const g of batch) {
        await destClient.query(
          `INSERT INTO git_ownership (repo_id, node_id, author_name, author_email, lines_authored, ownership_percentage, last_commit_date, total_commits)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            g.repo_id,
            g.node_id,
            g.author_name,
            g.author_email,
            g.lines_authored,
            g.ownership_percentage,
            g.last_commit_date,
            g.total_commits || 1
          ]
        );
      }
    }
    console.log(`✓ Git Ownership: ${gitRes.rows.length} records transferred`);

    // 5. Sync Chat Threads & Messages
    console.log("Syncing 'chat_threads' & 'chat_messages'...");
    const threadsRes = await sourceClient.query(`SELECT id, repo_id, title, created_at, updated_at FROM chat_threads`);
    for (const t of threadsRes.rows) {
      await destClient.query(
        `INSERT INTO chat_threads (id, repo_id, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = EXCLUDED.updated_at`,
        [t.id, t.repo_id, t.title, t.created_at, t.updated_at]
      );
    }

    const messagesRes = await sourceClient.query(`
      SELECT thread_id, role, content, referenced_nodes, blast_radius, created_at
      FROM chat_messages
    `);
    for (const m of messagesRes.rows) {
      await destClient.query(
        `INSERT INTO chat_messages (thread_id, role, content, referenced_nodes, blast_radius, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          m.thread_id,
          m.role,
          m.content,
          m.referenced_nodes ? JSON.stringify(m.referenced_nodes) : "[]",
          m.blast_radius ? JSON.stringify(m.blast_radius) : "[]",
          m.created_at
        ]
      );
    }
    console.log(`✓ Chat: ${threadsRes.rows.length} threads and ${messagesRes.rows.length} messages transferred`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("\n==========================================================");
    console.log(`🎉 Sync Completed Successfully in ${duration}s!`);
    console.log("==========================================================\n");
  } catch (err: any) {
    console.error("\n❌ Transfer error:", err.message || err);
    process.exit(1);
  } finally {
    sourceClient.release();
    destClient.release();
    await sourcePool.end();
    await destPool.end();
  }
}

syncDatabases();
