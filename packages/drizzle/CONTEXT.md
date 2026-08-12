# Drizzle

The Drizzle package owns connection-free concrete Store definitions for PostgreSQL, MySQL, and SQLite.

## Language

**Drizzle Store Definition**:
A synchronous definition value containing resolved SQL Record references and one flat Drizzle Schema. It owns no database connection or client lifetime.

**Drizzle Schema Generators**:
Host-supplied Drizzle Zod or Drizzle Valibot functions that fill missing Field Schemas after the final table exists. Static Field Schemas remain authoritative.

**Drizzle Schema**:
The flat map of final tables, PostgreSQL enum entities, and host relation entities returned by a Drizzle Store Definition.

## Relationships

- **Drizzle -> Store**: resolves lower-tier SQL Record Definitions and preserves Store Field Schema contracts.
- **Drizzle -> Core**: Thread definition factories add the complete Core Record catalog before applying host input.
