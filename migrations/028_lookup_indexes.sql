-- Lookups that grow with a business's history:
--   credit and debit notes found by the document they reference (every invoice's balance, what is
--   left to credit, refunds in the shift report);
--   the document that replaced a contingency document (each row of the document list asks);
--   payments in a shift (the shift report).

create index if not exists documents_referenced on documents (tenant_id, referenced_etdui) where referenced_etdui is not null;
create index if not exists documents_supersedes on documents (supersedes_document_id) where supersedes_document_id is not null;
create index if not exists invoice_payments_shift on invoice_payments (shift_id) where shift_id is not null;
