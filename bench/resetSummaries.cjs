const Database = require("better-sqlite3");
const db = new Database("bench_repos/zustand/.oss-analyser/knowledge.db");
db.prepare("UPDATE code_nodes SET summary_status = 'missing', summary = 'pending_summary'").run();
console.log("Reset successful: all code_nodes set to missing/pending_summary");
