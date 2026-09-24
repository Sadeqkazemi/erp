-- Creates the two platform-core database roles. Run once per environment as a DBA:
--   psql -v db=platform_core -v migration_password=... -v runtime_password=... -f scripts/provision-roles.sql
-- core_migration owns the schema and is used only by `npm run migration:run`.
-- core_runtime is used by the service: read/insert/update on tables, no DDL, no DELETE or TRUNCATE.
-- audit_events is additionally append-only through a trigger created by the migrations.

CREATE ROLE core_migration LOGIN PASSWORD :'migration_password';
CREATE ROLE core_runtime LOGIN PASSWORD :'runtime_password';

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO core_migration, core_runtime;

\connect :"db"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO core_migration;
GRANT USAGE ON SCHEMA public TO core_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE core_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO core_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE core_migration IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO core_runtime;
