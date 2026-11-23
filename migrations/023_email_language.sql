-- The language of the emails a business's customers receive (documents, reminders, statements,
-- quotations, store orders): the built-in templates and the lines the app writes into them.

alter table tenants add column email_language text not null default 'en' check (email_language in ('en', 'es'));
