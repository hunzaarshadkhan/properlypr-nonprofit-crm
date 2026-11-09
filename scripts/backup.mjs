import { DatabaseSync, backup } from "node:sqlite";
const source = process.env.CRM_DATABASE_PATH;
const destination = process.argv[2];
if (!source || !destination || source === destination) throw Error("Set CRM_DATABASE_PATH and pass a different backup destination.");
const db = new DatabaseSync(source, {readOnly:true});
await backup(db, destination);
db.close();
console.log("Consistent SQLite backup saved. Copy it to separate storage and test restoration.");
