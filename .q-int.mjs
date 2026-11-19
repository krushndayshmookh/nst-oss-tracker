// usage: node q.mjs '<js expression using db>'   (run from project dir for module resolution)
import { MongoClient } from 'mongodb';
const c = await MongoClient.connect('mongodb://127.0.0.1:27717'); const db = c.db(process.env.DBN || 'oss_int');
const r = await eval(`(async()=>(${process.argv[2]}))()`); console.log(JSON.stringify(r, null, 1)); await c.close();
