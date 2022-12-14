/**
 * Library made to simplify accessing / connecting to postgres databases,
 * and to cleanly handle when the pg module isn't installed.
 * @author mia-pi-git
 */

// @ts-ignore in case module doesn't exist
import type * as PG from 'pg';
import type {SQLStatement} from 'sql-template-strings';
import * as Streams from './streams';

export class PostgresDatabase {
	private pool: PG.Pool;
	constructor(config = PostgresDatabase.getConfig()) {
		try {
			this.pool = new (require('pg').Pool)(config);
		} catch (e: any) {
			this.pool = null!;
		}
	}
	async query(statement: string | SQLStatement, values?: any[]) {
		if (!this.pool) {
			throw new Error(`Attempting to use postgres without 'pg' installed`);
		}
		let result;
		try {
			result = await this.pool.query(statement, values);
		} catch (e: any) {
			// postgres won't give accurate stacks unless we do this
			throw new Error(e.message);
		}
		return result?.rows || [];
	}
	static getConfig() {
		let config: AnyObject = {};
		try {
			config = require('../config/config').usepostgres;
			if (!config) throw new Error('Missing config for pg database');
		} catch (e: any) {}
		return config;
	}
	async transaction(callback: (conn: PG.PoolClient) => any, depth = 0): Promise<any> {
		const conn = await this.pool.connect();
		await conn.query(`BEGIN`);
		let result;
		try {
			// eslint-disable-next-line callback-return
			result = await callback(conn);
		} catch (e: any) {
			await conn.query(`ROLLBACK`);
			// two concurrent transactions conflicted, try again
			if (e.code === '40001' && depth <= 10) {
				return this.transaction(callback, depth + 1);
				// There is a bug in Postgres that causes some
				// serialization failures to be reported as failed
				// unique constraint checks. Only retrying once since
				// it could be our fault (thanks chaos for this info / the first half of this comment)
			} else if (e.code === '23505' && !depth) {
				return this.transaction(callback, depth + 1);
			} else {
				throw e;
			}
		}
		await conn.query(`COMMIT`);
		return result;
	}
	stream<T = any>(query: string) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const db = this;
		return new Streams.ObjectReadStream<T>({
			async read(this: Streams.ObjectReadStream<T>) {
				const result = await db.query(query) as T[];
				if (!result.length) return this.pushEnd();
				// getting one row at a time means some slower queries
				// might help with performance
				this.buf.push(...result);
			},
		});
	}
}
