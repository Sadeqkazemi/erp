import { createDataSource } from './data-source';

// Migrations run with the migration role only. The runtime role never alters schema.
export default createDataSource(process.env.DATABASE_MIGRATION_URL);
