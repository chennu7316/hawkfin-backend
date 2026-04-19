import { Pool } from "pg";
import "dotenv/config";
import crypto from "crypto";

async function migrate() {
  const pool = new Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT) || 5432,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: false,
  });

  console.log("Connecting to database…");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS roles_name_lower_unique_idx
    ON roles (LOWER(name));
  `);

  await pool.query(`
    INSERT INTO roles (name)
    VALUES ('Admin'), ('Manager'), ('Developer'), ('Designer'), ('Viewer')
    ON CONFLICT DO NOTHING;
  `);

  console.log('✓ Table "roles" is ready.');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         VARCHAR(255) UNIQUE NOT NULL,
      first_name    VARCHAR(100) NOT NULL,
      last_name     VARCHAR(100) NOT NULL,
      password_hash VARCHAR(64)  NOT NULL,
      role          VARCHAR(50)  NOT NULL,
      password_hint TEXT,
      marketing_updates BOOLEAN NOT NULL DEFAULT FALSE,
      agree_terms BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hint TEXT,
      ADD COLUMN IF NOT EXISTS marketing_updates BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS agree_terms BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@finai.local";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "Admin@123";
  const adminPasswordHash = crypto
    .createHash("sha256")
    .update(adminPassword)
    .digest("hex");

  await pool.query(
    `
      UPDATE users
      SET role = 'Viewer'
      WHERE LOWER(role) = 'admin'
        AND LOWER(email) <> LOWER($1);
    `,
    [adminEmail],
  );

  await pool.query(
    `
      INSERT INTO users (
        email,
        first_name,
        last_name,
        password_hash,
        role,
        password_hint,
        marketing_updates,
        agree_terms
      )
      VALUES (LOWER($1), 'System', 'Admin', $2, 'Admin', NULL, FALSE, TRUE)
      ON CONFLICT (email) DO UPDATE
      SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        password_hint = EXCLUDED.password_hint,
        marketing_updates = EXCLUDED.marketing_updates,
        agree_terms = EXCLUDED.agree_terms;
    `,
    [adminEmail, adminPasswordHash],
  );

  console.log('✓ Table "users" is ready.');
  console.log(`✓ Admin login email: ${adminEmail}`);
  console.log(`✓ Admin login password: ${adminPassword}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name     VARCHAR(150) NOT NULL,
      email_address VARCHAR(255) NOT NULL,
      phone_number  VARCHAR(30),
      company_name  VARCHAR(150),
      interested_in VARCHAR(120) NOT NULL,
      message       TEXT NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'new',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE contact_messages
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'new';
  `);

  await pool.query(`
    UPDATE contact_messages
    SET status = 'new'
    WHERE status IS NULL OR status NOT IN ('new', 'contacted');
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx
    ON contact_messages (created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_messages_email_lower_idx
    ON contact_messages (LOWER(email_address));
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_messages_status_created_idx
    ON contact_messages (status, created_at DESC);
  `);

  console.log('✓ Table "contact_messages" is ready.');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email        VARCHAR(255) NOT NULL,
      code_hash    VARCHAR(64) NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS password_reset_codes_email_created_idx
    ON password_reset_codes (LOWER(email), created_at DESC);
  `);

  console.log('✓ Table "password_reset_codes" is ready.');

  await pool.query(`
    DROP TABLE IF EXISTS document_processing_logs CASCADE;
    DROP TABLE IF EXISTS formula_results CASCADE;
    DROP TABLE IF EXISTS formulas CASCADE;
    DROP TABLE IF EXISTS document_fields CASCADE;
    DROP TABLE IF EXISTS documents CASCADE;
    DROP TABLE IF EXISTS statement_uploads CASCADE;
    DROP TABLE IF EXISTS companies CASCADE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(200) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS companies_user_name_lower_idx
    ON companies (user_id, lower(trim(name)));
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS companies_user_id_created_idx
    ON companies (user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            UUID,
      user_email         VARCHAR(255) NOT NULL,
      company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      year_ending        VARCHAR(4) NOT NULL,
      document_type      VARCHAR(80) NOT NULL DEFAULT 'financial_statement',
      original_file_name VARCHAR(255) NOT NULL,
      content_type       VARCHAR(120) NOT NULL,
      file_size_bytes    BIGINT NOT NULL,
      bucket_name        VARCHAR(255) NOT NULL,
      object_name        TEXT NOT NULL,
      file_path          TEXT NOT NULL,
      gcs_uri            TEXT NOT NULL,
      status             VARCHAR(20) NOT NULL DEFAULT 'uploaded',
      processor_name     TEXT,
      extraction_error   TEXT,
      uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at       TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_fields (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      field_key        TEXT NOT NULL,
      field_year       VARCHAR(4),
      field_value_text TEXT,
      field_value      NUMERIC(20,4),
      confidence_score NUMERIC(7,6),
      page_number      INTEGER,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS formulas (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      formula_name       VARCHAR(100) NOT NULL UNIQUE,
      formula_expression TEXT NOT NULL,
      description        TEXT,
      is_active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS formula_results (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      formula_id    UUID NOT NULL REFERENCES formulas(id) ON DELETE CASCADE,
      result_value  NUMERIC(20,6),
      details       JSONB,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (document_id, formula_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_processing_logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      stage       VARCHAR(50) NOT NULL,
      status      VARCHAR(20) NOT NULL,
      message     TEXT,
      payload_json JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO formulas (formula_name, formula_expression, description, is_active)
    VALUES
      ('grossProfitRatio', '((revenue_from_operations - cost_of_materials_consumed) / revenue_from_operations) * 100', 'Gross Profit Ratio (%)', TRUE),
      ('netProfitRatio', '(profit_loss_for_the_year / revenue_from_operations) * 100', 'Net Profit Ratio (%)', TRUE),
      ('operatingProfitRatio', '(operating_profit_before_working_capital_changes / revenue_from_operations) * 100', 'Operating Profit Ratio (%)', TRUE),
      ('returnOnAssets', '(profit_loss_for_the_year / total_assets) * 100', 'Return on Assets - ROA (%)', TRUE),
      ('returnOnEquity', '(profit_loss_for_the_year / total_equity) * 100', 'Return on Equity - ROE (%)', TRUE),
      ('returnOnCapitalEmployed', '((net_profit_before_taxation + interest_expense) / (total_equity + long_term_borrowings)) * 100', 'Return on Capital Employed - ROCE (%)', TRUE),
      ('ebitdaMargin', '((net_profit_before_taxation + interest_expense + depreciation_and_amortization_expense) / revenue_from_operations) * 100', 'EBITDA Margin (%)', TRUE),
      ('ebitMargin', '((net_profit_before_taxation + interest_expense) / revenue_from_operations) * 100', 'EBIT Margin (%)', TRUE),
      ('currentRatio', 'current_assets / current_liabilities', '2.1 Current Ratio', TRUE),
      ('quickRatio', '(current_assets - inventories) / current_liabilities', '2.2 Quick Ratio (Acid Test)', TRUE),
      ('cashRatio', '(cash_and_cash_equivalents + short_term_investments) / current_liabilities', '2.3 Cash Ratio', TRUE),
      ('absoluteLiquidRatio', 'cash_and_cash_equivalents / current_liabilities', '2.4 Absolute Liquid Ratio', TRUE),
      ('debtToEquityRatio', 'total_debt / total_equity', '3.1 Debt-to-Equity Ratio', TRUE),
      ('debtRatio', 'total_debt / total_assets', '3.2 Debt Ratio', TRUE),
      ('equityRatio', 'total_equity / total_assets', '3.3 Equity Ratio', TRUE),
      ('interestCoverageRatio', '(net_profit_before_taxation + interest_expense) / interest_expense', '3.4 Interest Coverage Ratio', TRUE),
      ('debtServiceCoverageRatio', '(net_profit_before_taxation + depreciation_and_amortization_expense + interest_expense) / (abs(interest_paid) + abs(principal_repayment))', '3.5 Debt Service Coverage Ratio (DSCR)', TRUE),
      ('operatingCashFlowRatio', '|net_cash_from_operating_activities| / |current_liabilities|', '6.1 Operating Cash Flow Ratio', TRUE),
      ('freeCashFlow', '|net_cash_from_operating_activities| - |purchase_of_fixed_assets|', '6.2 Free Cash Flow (₹)', TRUE),
      ('cashFlowToRevenueRatio', '(|net_cash_from_operating_activities| / |revenue_from_operations|) * 100', '6.3 Cash Flow to Revenue Ratio (%)', TRUE),
      ('cashReturnOnAssets', '(|net_cash_from_operating_activities| / |total_assets|) * 100', '6.4 Cash Return on Assets (%)', TRUE),
      ('cashFlowCoverageRatio', '|net_cash_from_operating_activities| / |total_debt|', '6.5 Cash Flow Coverage Ratio', TRUE),
      ('cashFlowToDebtRatio', '|net_cash_from_operating_activities| / |total_debt|', '6.6 Cash Flow to Debt Ratio', TRUE),
      ('cashFlowAdequacyRatio', '|net_cash_from_operating_activities| / (|purchase_of_fixed_assets| + |dividends_paid| + |principal_repayment|)', '6.7 Cash Flow Adequacy Ratio', TRUE),
      ('dupontRoe3Way', '(profit_loss_for_the_year / revenue_from_operations) * (revenue_from_operations / total_assets) * (total_assets / total_equity)', '7.1 DuPont ROE (3-Way)', TRUE),
      ('dupontRoe5Way', '(profit_loss_for_the_year / net_profit_before_taxation) * (net_profit_before_taxation / (net_profit_before_taxation + interest_expense)) * ((net_profit_before_taxation + interest_expense) / revenue_from_operations) * (revenue_from_operations / total_assets) * (total_assets / total_equity)', '7.2 DuPont ROE (5-Way)', TRUE),
      ('degreeOfOperatingLeverage', '(revenue_from_operations - cost_of_materials_consumed) / (net_profit_before_taxation + interest_expense)', '8.1 Degree of Operating Leverage (DOL)', TRUE),
      ('degreeOfFinancialLeverage', '(net_profit_before_taxation + interest_expense) / net_profit_before_taxation', '8.2 Degree of Financial Leverage (DFL)', TRUE),
      ('degreeOfCombinedLeverage', 'DOL * DFL', '8.3 Degree of Combined Leverage (DCL)', TRUE),
      ('taxRate', '((current_tax + deferred_tax) / net_profit_before_taxation) * 100', '9.1 Tax Rate (%)', TRUE),
      ('effectiveTaxRate', '(tax_expense / net_profit_before_taxation) * 100', '9.2 Effective Tax Rate (%)', TRUE),
      ('employeeCostToRevenueRatio', '(employee_benefits_expense / revenue_from_operations) * 100', '9.3 Employee Cost to Revenue Ratio (%)', TRUE),
      ('financeCostToRevenueRatio', '(finance_costs / revenue_from_operations) * 100', '9.4 Finance Cost to Revenue Ratio (%)', TRUE),
      ('depreciationToRevenueRatio', '(depreciation_and_amortization_expense / revenue_from_operations) * 100', '9.5 Depreciation to Revenue Ratio (%)', TRUE),
      ('otherExpensesToRevenueRatio', '(other_expenses / revenue_from_operations) * 100', '9.6 Other Expenses to Revenue Ratio (%)', TRUE),
      ('capitalWorkInProgressRatio', '(capital_work_in_progress / property_plant_equipment) * 100', '9.7 Capital Work-in-Progress Ratio (%)', TRUE),
      ('interestIncomeToInterestExpenseRatio', 'interest_income / interest_expense', '9.8 Interest Income to Interest Expense Ratio', TRUE),
      ('inventoryTurnoverRatio', 'cost_of_materials_consumed / average_inventories', '4.1 Inventory Turnover Ratio (Times)', TRUE),
      ('daysInventoryOutstanding', '(average_inventories / cost_of_materials_consumed) * 365', '4.2 Days Inventory Outstanding - DIO (Days)', TRUE),
      ('receivablesTurnoverRatio', 'revenue_from_operations / average_trade_receivables', '4.3 Receivables Turnover Ratio (Times)', TRUE),
      ('daysSalesOutstanding', '(average_trade_receivables / revenue_from_operations) * 365', '4.4 Days Sales Outstanding - DSO (Days)', TRUE),
      ('payablesTurnoverRatio', 'cost_of_materials_consumed / average_trade_payables', '4.5 Payables Turnover Ratio (Times)', TRUE),
      ('daysPayablesOutstanding', '(average_trade_payables / cost_of_materials_consumed) * 365', '4.6 Days Payables Outstanding - DPO (Days)', TRUE),
      ('assetTurnoverRatio', 'revenue_from_operations / average_total_assets', '4.7 Asset Turnover Ratio (Times)', TRUE),
      ('fixedAssetTurnoverRatio', 'revenue_from_operations / average_fixed_assets', '4.8 Fixed Asset Turnover Ratio (Times)', TRUE),
      ('workingCapitalTurnover', 'revenue_from_operations / working_capital', '4.9 Working Capital Turnover (Times)', TRUE),
      ('operatingCycleDays', 'DIO + DSO', '4.10 Operating Cycle (Days)', TRUE),
      ('cashConversionCycle', 'DIO + DSO - DPO', '4.11 Cash Conversion Cycle - CCC (Days)', TRUE),
      ('capitalIntensityRatio', 'fixed_assets / revenue_from_operations', '4.12 Capital Intensity Ratio', TRUE)
    ON CONFLICT (formula_name) DO UPDATE
      SET formula_expression = EXCLUDED.formula_expression,
          description = EXCLUDED.description,
          is_active = EXCLUDED.is_active;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS documents_user_id_year_uploaded_idx
    ON documents (user_id, year_ending, uploaded_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS documents_company_year_uploaded_idx
    ON documents (company_id, year_ending, uploaded_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS documents_user_email_uploaded_idx
    ON documents (LOWER(user_email), uploaded_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS document_fields_document_id_key_year_idx
    ON document_fields (document_id, field_key, field_year);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS formula_results_document_id_idx
    ON formula_results (document_id);
  `);

  console.log('✓ New document processing design is ready.');
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
