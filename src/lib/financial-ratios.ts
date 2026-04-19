type MetricValue = number | null;

type MetricMap = Record<string, MetricValue>;
type MetricSource = "document" | "alias" | "derived";
type MetricSourceMap = Record<string, MetricSource>;

type EntityLike = {
  type: string;
  mentionText: string;
};

export type RatioResult = {
  value: number | null;
  formula: string;
  missingFields: string[];
  notes: string[];
  source: "document" | "derived" | "mixed" | "unknown";
};

export type RatioCategory = Record<string, RatioResult>;

export type FinancialRatios = {
  profitabilityRatios: RatioCategory;
  liquidityRatios: RatioCategory;
  leverageSolvencyRatios: RatioCategory;
  activityEfficiencyRatios: RatioCategory;
  marketInvestmentRatios: RatioCategory;
  cashFlowRatios: RatioCategory;
  dupontAnalysis: RatioCategory;
  leverageAnalysis: RatioCategory;
  otherImportantRatios: RatioCategory;
};

function normalizeMetricKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function toNumberOrNull(raw: string) {
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function divide(numerator: MetricValue, denominator: MetricValue) {
  if (
    numerator === null ||
    denominator === null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function multiply(value: MetricValue, factor: number) {
  if (value === null || !Number.isFinite(value)) return null;
  return value * factor;
}

function averageWithFallback(params: {
  metrics: MetricMap;
  openingKey: string;
  closingKey: string;
  /** Shown when only closing is used for the average proxy. */
  fallbackNote: string;
}) {
  const opening = params.metrics[params.openingKey];
  const closing = params.metrics[params.closingKey];

  if (
    opening !== null &&
    opening !== undefined &&
    Number.isFinite(opening as number) &&
    closing !== null &&
    closing !== undefined &&
    Number.isFinite(closing as number)
  ) {
    return {
      value: ((opening as number) + (closing as number)) / 2,
      missingFields: [] as string[],
      notes: [] as string[],
    };
  }

  if (closing !== null && closing !== undefined && Number.isFinite(closing as number)) {
    return {
      value: closing as number,
      missingFields: [params.openingKey],
      notes: [params.fallbackNote],
    };
  }

  return {
    value: null,
    missingFields: [params.openingKey, params.closingKey],
    notes: [] as string[],
  };
}

function buildRatio(
  value: MetricValue,
  formula: string,
  missingFields: string[] = [],
  notes: string[] = [],
): RatioResult {
  return {
    value,
    formula,
    missingFields: Array.from(new Set(missingFields)),
    notes,
    source: "unknown",
  };
}

function getMissingMetricNames(
  required: Array<{ key: string; value: MetricValue }>,
) {
  return required
    .filter(({ value }) => value === null || value === undefined || !Number.isFinite(value))
    .map(({ key }) => key);
}

/** Absolute value for cash-flow ratio inputs (null stays null). */
function absMetric(v: number | null): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.abs(v);
}

/** Sum line items; missing components treated as 0. Returns null only if no line item was present. */
function deriveCurrentAssetsFromLineItems(metrics: MetricMap): number | null {
  if (
    metrics.current_assets !== null &&
    metrics.current_assets !== undefined &&
    Number.isFinite(metrics.current_assets)
  ) {
    return metrics.current_assets;
  }
  const parts: MetricValue[] = [
    metrics.current_investments,
    metrics.inventories,
    metrics.trade_receivables,
    metrics.cash_and_cash_equivalents,
    metrics.short_term_loans_and_advances,
    metrics.other_current_assets,
  ];
  const hasAny = parts.some(
    (v) => v !== null && v !== undefined && Number.isFinite(v as number),
  );
  if (!hasAny) return null;
  let total = 0;
  for (const v of parts) {
    total += v ?? 0;
  }
  return total;
}

function deriveCurrentLiabilitiesFromLineItems(metrics: MetricMap): number | null {
  if (
    metrics.current_liabilities !== null &&
    metrics.current_liabilities !== undefined &&
    Number.isFinite(metrics.current_liabilities)
  ) {
    return metrics.current_liabilities;
  }
  const parts: MetricValue[] = [
    metrics.short_term_borrowings,
    metrics.trade_payables,
    metrics.other_current_liabilities,
    metrics.short_term_provisions,
  ];
  const hasAny = parts.some(
    (v) => v !== null && v !== undefined && Number.isFinite(v as number),
  );
  if (!hasAny) return null;
  let total = 0;
  for (const v of parts) {
    total += v ?? 0;
  }
  return total;
}

function deriveTotalDebtFromBorrowings(metrics: MetricMap): number | null {
  if (
    metrics.total_debt !== null &&
    metrics.total_debt !== undefined &&
    Number.isFinite(metrics.total_debt)
  ) {
    return metrics.total_debt;
  }
  const lt = metrics.long_term_borrowings;
  const st = metrics.short_term_borrowings;
  const hasAny =
    (lt !== null && lt !== undefined && Number.isFinite(lt as number)) ||
    (st !== null && st !== undefined && Number.isFinite(st as number));
  if (!hasAny) return null;
  let total = 0;
  total += lt ?? 0;
  total += st ?? 0;
  return total;
}

function applyDerivedTotalDebt(metrics: MetricMap, metricSources: MetricSourceMap) {
  const hasTD =
    metrics.total_debt !== null &&
    metrics.total_debt !== undefined &&
    Number.isFinite(metrics.total_debt);
  if (!hasTD) {
    const d = deriveTotalDebtFromBorrowings(metrics);
    if (d !== null) {
      metrics.total_debt = d;
      metricSources.total_debt = "derived";
    }
  }
}

function applyDerivedCurrentAssetsAndLiabilities(
  metrics: MetricMap,
  metricSources: MetricSourceMap,
) {
  const hasCA =
    metrics.current_assets !== null &&
    metrics.current_assets !== undefined &&
    Number.isFinite(metrics.current_assets);
  if (!hasCA) {
    const d = deriveCurrentAssetsFromLineItems(metrics);
    if (d !== null) {
      metrics.current_assets = d;
      metricSources.current_assets = "derived";
    }
  }
  const hasCL =
    metrics.current_liabilities !== null &&
    metrics.current_liabilities !== undefined &&
    Number.isFinite(metrics.current_liabilities);
  if (!hasCL) {
    const d = deriveCurrentLiabilitiesFromLineItems(metrics);
    if (d !== null) {
      metrics.current_liabilities = d;
      metricSources.current_liabilities = "derived";
    }
  }
}

export function extractFinancialMetricsFromEntities(entities: EntityLike[]) {
  const metrics: MetricMap = {};
  const metricSources: MetricSourceMap = {};

  for (const entity of entities) {
    const normalizedType = normalizeMetricKey(entity.type);
    const value = toNumberOrNull(entity.mentionText);
    if (!normalizedType || value === null) continue;
    metrics[normalizedType] = value;
    metricSources[normalizedType] = "document";
  }

  const aliases: Array<[string, string]> = [
    ["revenue_from_operations", "revenue_from_operation"],
    ["short_term_investments", "current_investments"],
    ["finance_costs", "interest_expense"],
    ["interest_paid", "interest_expense"],
    ["property_plant_and_equipment", "property_plant_equipment"],
    ["capital_work_in_progress", "capital_work_in_progresses"],
    ["profit_loss_for_the_year", "profit_for_the_year"],
    ["variable_costs", "variable_cost"],
  ];

  for (const [target, source] of aliases) {
    if (metrics[target] === null || metrics[target] === undefined) {
      const sourceValue = metrics[source];
      if (sourceValue !== null && sourceValue !== undefined) {
        metrics[target] = sourceValue;
        metricSources[target] = "alias";
      }
    }
  }

  applyDerivedTotalDebt(metrics, metricSources);

  const hasFixedAssets =
    metrics.fixed_assets !== null && metrics.fixed_assets !== undefined;
  const ppe =
    metrics.property_plant_equipment ??
    metrics.property_plant_and_equipment ??
    null;
  const intangibleAssets = metrics.intangible_assets ?? null;
  const cWip = metrics.capital_work_in_progress ?? null;
  if (!hasFixedAssets && ppe !== null && intangibleAssets !== null && cWip !== null) {
    metrics.fixed_assets = ppe + intangibleAssets + cWip;
    metricSources.fixed_assets = "derived";
  }

  applyDerivedCurrentAssetsAndLiabilities(metrics, metricSources);

  const hasWorkingCapital =
    metrics.working_capital !== null && metrics.working_capital !== undefined;
  const currentAssets = metrics.current_assets ?? null;
  const currentLiabilities = metrics.current_liabilities ?? null;
  if (!hasWorkingCapital && currentAssets !== null && currentLiabilities !== null) {
    metrics.working_capital = currentAssets - currentLiabilities;
    metricSources.working_capital = "derived";
  }

  const currentInvestments = metrics.current_investments ?? null;
  const inventories = metrics.inventories ?? null;
  const tradeReceivables = metrics.trade_receivables ?? null;
  const cashAndCashEquivalents = metrics.cash_and_cash_equivalents ?? null;
  const shortTermLoansAndAdvances = metrics.short_term_loans_and_advances ?? null;
  const otherCurrentAssets = metrics.other_current_assets ?? null;

  const hasTotalEquity =
    metrics.total_equity !== null && metrics.total_equity !== undefined;
  const shareCapital = metrics.share_capital ?? 0;
  const reservesAndSurplus = metrics.reserves_and_surplus ?? 0;
  const shareApplicationMoneyPendingAllotment =
    metrics.share_application_money_pending_allotment ?? 0;
  const moneyReceivedAgainstShareWarrants =
    metrics.money_received_against_share_warrants ?? 0;
  if (!hasTotalEquity) {
    metrics.total_equity =
      shareCapital +
      reservesAndSurplus +
      shareApplicationMoneyPendingAllotment +
      moneyReceivedAgainstShareWarrants;
    metricSources.total_equity = "derived";
  }

  const hasTotalAssets =
    metrics.total_assets !== null && metrics.total_assets !== undefined;
  const intangibleAssetsUnderDevelopment =
    metrics.intangible_assets_under_development ?? null;
  const nonCurrentInvestments = metrics.non_current_investments ?? null;
  const longTermLoansAndAdvances = metrics.long_term_loans_and_advances ?? null;
  const otherNonCurrentAssets = metrics.other_non_current_assets ?? null;
  const deferredTaxAssetsNet = metrics.deferred_tax_assets_net ?? null;
  const matCreditEntitlement = metrics.mat_credit_entitlement ?? null;
  if (
    !hasTotalAssets &&
    ppe !== null &&
    intangibleAssets !== null &&
    intangibleAssetsUnderDevelopment !== null &&
    cWip !== null &&
    nonCurrentInvestments !== null &&
    longTermLoansAndAdvances !== null &&
    otherNonCurrentAssets !== null &&
    deferredTaxAssetsNet !== null &&
    matCreditEntitlement !== null &&
    currentInvestments !== null &&
    inventories !== null &&
    tradeReceivables !== null &&
    cashAndCashEquivalents !== null &&
    shortTermLoansAndAdvances !== null &&
    otherCurrentAssets !== null
  ) {
    metrics.total_assets =
      ppe +
      intangibleAssets +
      intangibleAssetsUnderDevelopment +
      cWip +
      nonCurrentInvestments +
      longTermLoansAndAdvances +
      otherNonCurrentAssets +
      deferredTaxAssetsNet +
      matCreditEntitlement +
      currentInvestments +
      inventories +
      tradeReceivables +
      cashAndCashEquivalents +
      shortTermLoansAndAdvances +
      otherCurrentAssets;
    metricSources.total_assets = "derived";
  }

  const hasTaxExpense =
    metrics.tax_expense !== null && metrics.tax_expense !== undefined;
  const currentTax = metrics.current_tax ?? null;
  const deferredTax = metrics.deferred_tax ?? null;
  if (!hasTaxExpense && currentTax !== null && deferredTax !== null) {
    metrics.tax_expense = currentTax + deferredTax;
    metricSources.tax_expense = "derived";
  }

  return { metrics, metricSources };
}

function inferRatioSource(
  formula: string,
  missingFields: string[],
  value: number | null,
  metricSources: MetricSourceMap,
): RatioResult["source"] {
  const tokens = formula.toLowerCase().match(/[a-z_]+/g) ?? [];
  const candidateFields = new Set<string>();

  for (const token of tokens) {
    if (token.includes("_")) candidateFields.add(token);
  }
  for (const field of missingFields) {
    const normalized = normalizeMetricKey(field);
    if (normalized.includes("_")) candidateFields.add(normalized);
  }

  let hasDocument = false;
  let hasDerived = false;
  for (const field of candidateFields) {
    const source = metricSources[field];
    if (!source) continue;
    if (source === "derived") hasDerived = true;
    if (source === "document" || source === "alias") hasDocument = true;
  }

  if (hasDocument && hasDerived) return "mixed";
  if (hasDerived) return "derived";
  if (hasDocument) return "document";
  // If a ratio is computable but source inference is ambiguous,
  // treat it as mixed instead of showing "unknown" in UI.
  if (value !== null) return "mixed";
  return "unknown";
}

function attachRatioSources(
  category: RatioCategory,
  metricSources: MetricSourceMap,
) {
  for (const ratio of Object.values(category)) {
    ratio.source = inferRatioSource(
      ratio.formula,
      ratio.missingFields,
      ratio.value,
      metricSources,
    );
  }
}

export function computeFinancialRatios(
  metrics: MetricMap,
  metricSources: MetricSourceMap = {},
): FinancialRatios {
  applyDerivedCurrentAssetsAndLiabilities(metrics, metricSources);
  applyDerivedTotalDebt(metrics, metricSources);

  const profitabilityRatios: RatioCategory = {};
  const liquidityRatios: RatioCategory = {};
  const leverageSolvencyRatios: RatioCategory = {};
  const activityEfficiencyRatios: RatioCategory = {};
  const marketInvestmentRatios: RatioCategory = {};
  const cashFlowRatios: RatioCategory = {};
  const dupontAnalysis: RatioCategory = {};
  const leverageAnalysis: RatioCategory = {};
  const otherImportantRatios: RatioCategory = {};

  const totalDebt = metrics.total_debt ?? null;
  const totalEquity = metrics.total_equity ?? null;
  const totalAssets = metrics.total_assets ?? null;
  const interestExpense = metrics.interest_expense ?? null;
  const pbt = metrics.net_profit_before_taxation ?? null;
  const depreciation = metrics.depreciation_and_amortization_expense ?? null;
  const interestPaid = metrics.interest_paid ?? null;
  const principalRepayment = metrics.principal_repayment ?? null;
  const fixedAssets = metrics.fixed_assets ?? null;
  const longTermBorrowings = metrics.long_term_borrowings ?? null;
  const revenue = metrics.revenue_from_operations ?? null;
  const costOfMaterials = metrics.cost_of_materials_consumed ?? null;
  const profitForYear = metrics.profit_loss_for_the_year ?? null;
  const operatingProfitBeforeWorkingCapitalChanges =
    metrics.operating_profit_before_working_capital_changes ?? null;
  const currentLiabilities = metrics.current_liabilities ?? null;
  const currentAssets = metrics.current_assets ?? null;
  const inventories = metrics.inventories ?? null;
  const shortTermInvestments =
    metrics.short_term_investments ?? metrics.current_investments ?? null;
  const cashAndCashEquivalents = metrics.cash_and_cash_equivalents ?? null;

  profitabilityRatios.grossProfitRatio = buildRatio(
    multiply(
      divide(
        revenue !== null && costOfMaterials !== null
          ? revenue - costOfMaterials
          : null,
        revenue,
      ),
      100,
    ),
    "((revenue_from_operations - cost_of_materials_consumed) / revenue_from_operations) * 100",
    getMissingMetricNames([
      { key: "revenue_from_operations", value: revenue },
      { key: "cost_of_materials_consumed", value: costOfMaterials },
    ]),
  );
  profitabilityRatios.netProfitRatio = buildRatio(
    multiply(divide(profitForYear, revenue), 100),
    "(profit_loss_for_the_year / revenue_from_operations) * 100",
    getMissingMetricNames([
      { key: "profit_loss_for_the_year", value: profitForYear },
      { key: "revenue_from_operations", value: revenue },
    ]),
  );
  profitabilityRatios.operatingProfitRatio = buildRatio(
    multiply(divide(operatingProfitBeforeWorkingCapitalChanges, revenue), 100),
    "(operating_profit_before_working_capital_changes / revenue_from_operations) * 100",
    getMissingMetricNames([
      {
        key: "operating_profit_before_working_capital_changes",
        value: operatingProfitBeforeWorkingCapitalChanges,
      },
      { key: "revenue_from_operations", value: revenue },
    ]),
  );
  profitabilityRatios.returnOnAssets = buildRatio(
    multiply(divide(profitForYear, totalAssets), 100),
    "(profit_loss_for_the_year / total_assets) * 100",
    getMissingMetricNames([
      { key: "profit_loss_for_the_year", value: profitForYear },
      { key: "total_assets", value: totalAssets },
    ]),
  );
  profitabilityRatios.returnOnEquity = buildRatio(
    multiply(divide(profitForYear, totalEquity), 100),
    "(profit_loss_for_the_year / total_equity) * 100",
    getMissingMetricNames([
      { key: "profit_loss_for_the_year", value: profitForYear },
      { key: "total_equity", value: totalEquity },
    ]),
  );
  profitabilityRatios.returnOnCapitalEmployed = buildRatio(
    multiply(
      divide(
        pbt !== null && interestExpense !== null ? pbt + interestExpense : null,
        totalEquity !== null
          ? totalEquity + (longTermBorrowings ?? 0)
          : null,
      ),
      100,
    ),
    "((net_profit_before_taxation + interest_expense) / (total_equity + long_term_borrowings)) * 100",
    getMissingMetricNames([
      { key: "net_profit_before_taxation", value: pbt },
      { key: "interest_expense", value: interestExpense },
      { key: "total_equity", value: totalEquity },
    ]),
    longTermBorrowings === null
      ? ["long_term_borrowings not extracted; treated as 0 in capital employed"]
      : [],
  );
  profitabilityRatios.ebitdaMargin = buildRatio(
    multiply(
      divide(
        pbt !== null && interestExpense !== null && depreciation !== null
          ? pbt + interestExpense + depreciation
          : null,
        revenue,
      ),
      100,
    ),
    "((net_profit_before_taxation + interest_expense + depreciation_and_amortization_expense) / revenue_from_operations) * 100",
    getMissingMetricNames([
      { key: "net_profit_before_taxation", value: pbt },
      { key: "interest_expense", value: interestExpense },
      { key: "depreciation_and_amortization_expense", value: depreciation },
      { key: "revenue_from_operations", value: revenue },
    ]),
  );
  profitabilityRatios.ebitMargin = buildRatio(
    multiply(
      divide(
        pbt !== null && interestExpense !== null ? pbt + interestExpense : null,
        revenue,
      ),
      100,
    ),
    "((net_profit_before_taxation + interest_expense) / revenue_from_operations) * 100",
    getMissingMetricNames([
      { key: "net_profit_before_taxation", value: pbt },
      { key: "interest_expense", value: interestExpense },
      { key: "revenue_from_operations", value: revenue },
    ]),
  );

  const liquidityNotesCurrent = [
    "Note: current_assets = current_investments + inventories + trade_receivables + cash_and_cash_equivalents + short_term_loans_and_advances + other_current_assets",
    "Note: current_liabilities = short_term_borrowings + trade_payables + other_current_liabilities + short_term_provisions",
  ];
  const liquidityNotesQuick = [
    "Note: quick_assets = current_investments + trade_receivables + cash_and_cash_equivalents + short_term_loans_and_advances + other_current_assets",
  ];

  liquidityRatios.currentRatio = buildRatio(
    divide(currentAssets, currentLiabilities),
    "current_assets / current_liabilities",
    getMissingMetricNames([
      { key: "current_assets", value: currentAssets },
      { key: "current_liabilities", value: currentLiabilities },
    ]),
    [...liquidityNotesCurrent],
  );
  liquidityRatios.quickRatio = buildRatio(
    divide(
      currentAssets !== null && currentLiabilities !== null
        ? currentAssets - (inventories ?? 0)
        : null,
      currentLiabilities,
    ),
    "(current_assets - inventories) / current_liabilities",
    getMissingMetricNames([
      { key: "current_assets", value: currentAssets },
      { key: "current_liabilities", value: currentLiabilities },
    ]),
    [...liquidityNotesQuick],
  );
  liquidityRatios.cashRatio = buildRatio(
    divide(
      currentLiabilities !== null
        ? (cashAndCashEquivalents ?? 0) + (shortTermInvestments ?? 0)
        : null,
      currentLiabilities,
    ),
    "(cash_and_cash_equivalents + short_term_investments) / current_liabilities",
    getMissingMetricNames([{ key: "current_liabilities", value: currentLiabilities }]),
    [],
  );
  liquidityRatios.absoluteLiquidRatio = buildRatio(
    divide(
      currentLiabilities !== null ? (cashAndCashEquivalents ?? 0) : null,
      currentLiabilities,
    ),
    "cash_and_cash_equivalents / current_liabilities",
    getMissingMetricNames([{ key: "current_liabilities", value: currentLiabilities }]),
    [],
  );

  const leverageNoteTotalDebt = [
    "Note: total_debt = long_term_borrowings + short_term_borrowings (missing borrowings treated as 0 when derived)",
  ];

  const dscrDenominator = (() => {
    const hasCashFlow =
      (interestPaid !== null &&
        interestPaid !== undefined &&
        Number.isFinite(interestPaid)) ||
      (principalRepayment !== null &&
        principalRepayment !== undefined &&
        Number.isFinite(principalRepayment));
    if (hasCashFlow) {
      const sum = Math.abs(interestPaid ?? 0) + Math.abs(principalRepayment ?? 0);
      return sum > 0 ? sum : null;
    }
    if (interestExpense !== null && Number.isFinite(interestExpense) && interestExpense !== 0) {
      return Math.abs(interestExpense);
    }
    return null;
  })();

  const dscrNumerator =
    pbt !== null && interestExpense !== null
      ? pbt + (depreciation ?? 0) + interestExpense
      : null;

  leverageSolvencyRatios.debtToEquityRatio = buildRatio(
    divide(totalDebt, totalEquity),
    "total_debt / total_equity",
    getMissingMetricNames([
      { key: "total_debt", value: totalDebt },
      { key: "total_equity", value: totalEquity },
    ]),
    [...leverageNoteTotalDebt],
  );
  leverageSolvencyRatios.debtRatio = buildRatio(
    divide(totalDebt, totalAssets),
    "total_debt / total_assets",
    getMissingMetricNames([
      { key: "total_debt", value: totalDebt },
      { key: "total_assets", value: totalAssets },
    ]),
    [...leverageNoteTotalDebt],
  );
  leverageSolvencyRatios.equityRatio = buildRatio(
    divide(totalEquity, totalAssets),
    "total_equity / total_assets",
    getMissingMetricNames([
      { key: "total_equity", value: totalEquity },
      { key: "total_assets", value: totalAssets },
    ]),
    [],
  );
  leverageSolvencyRatios.interestCoverageRatio = buildRatio(
    divide(
      pbt !== null && interestExpense !== null ? pbt + interestExpense : null,
      interestExpense,
    ),
    "(net_profit_before_taxation + interest_expense) / interest_expense",
    getMissingMetricNames([
      { key: "net_profit_before_taxation", value: pbt },
      { key: "interest_expense", value: interestExpense },
    ]),
    [],
  );
  leverageSolvencyRatios.debtServiceCoverageRatio = buildRatio(
    divide(dscrNumerator, dscrDenominator),
    "(net_profit_before_taxation + depreciation_and_amortization_expense + interest_expense) / (abs(interest_paid) + abs(principal_repayment) or interest_expense if cash flow lines missing)",
    [
      ...getMissingMetricNames([
        { key: "net_profit_before_taxation", value: pbt },
        { key: "interest_expense", value: interestExpense },
      ]),
      ...(dscrDenominator === null
        ? ["interest_paid", "principal_repayment", "interest_expense"]
        : []),
    ],
    [
      "Note: numerator uses depreciation_and_amortization_expense = 0 when not extracted.",
      "Note: denominator prefers |interest_paid| + |principal_repayment| (e.g. from cash flow); if absent, uses |interest_expense|.",
    ],
  );
  leverageSolvencyRatios.fixedAssetsToNetWorth = buildRatio(
    divide(fixedAssets, totalEquity),
    "fixed_assets / total_equity",
    [fixedAssets, totalEquity].some((v) => v === null)
      ? ["fixed_assets", "total_equity"]
      : [],
  );
  leverageSolvencyRatios.proprietaryRatio = buildRatio(
    divide(totalEquity, totalAssets),
    "total_equity / total_assets",
    [totalEquity, totalAssets].some((v) => v === null)
      ? ["total_equity", "total_assets"]
      : [],
  );
  leverageSolvencyRatios.totalAssetsToDebtRatio = buildRatio(
    divide(totalAssets, totalDebt),
    "total_assets / total_debt",
    [totalAssets, totalDebt].some((v) => v === null)
      ? ["total_assets", "total_debt"]
      : [],
  );
  leverageSolvencyRatios.longTermDebtToEquityRatio = buildRatio(
    divide(longTermBorrowings, totalEquity),
    "long_term_borrowings / total_equity",
    [longTermBorrowings, totalEquity].some((v) => v === null)
      ? ["long_term_borrowings", "total_equity"]
      : [],
  );

  const warnOpeningInventories =
    "⚠️ REQUIRES ADDITIONAL DATA: opening_inventories (for calculating average). Alternative: Use closing inventories if opening balance not available.";
  const warnOpeningReceivables =
    "⚠️ REQUIRES ADDITIONAL DATA: opening_trade_receivables (for calculating average). Alternative: Use closing trade_receivables if opening balance not available.";
  const warnOpeningPayables =
    "⚠️ REQUIRES ADDITIONAL DATA: opening_trade_payables (for calculating average). Alternative: Use closing trade_payables if opening balance not available.";
  const warnOpeningTotalAssets =
    "⚠️ REQUIRES ADDITIONAL DATA: opening_total_assets (for calculating average). Alternative: Use closing total_assets if opening balance not available.";
  const warnOpeningFixedAssets =
    "⚠️ REQUIRES ADDITIONAL DATA: opening_fixed_assets (for calculating average). Alternative: Use closing fixed_assets if opening balance not available.";

  const inventoriesAvg = averageWithFallback({
    metrics,
    openingKey: "opening_inventories",
    closingKey: "inventories",
    fallbackNote: warnOpeningInventories,
  });
  const receivablesAvg = averageWithFallback({
    metrics,
    openingKey: "opening_trade_receivables",
    closingKey: "trade_receivables",
    fallbackNote: warnOpeningReceivables,
  });
  const payablesAvg = averageWithFallback({
    metrics,
    openingKey: "opening_trade_payables",
    closingKey: "trade_payables",
    fallbackNote: warnOpeningPayables,
  });
  const totalAssetsAvg = averageWithFallback({
    metrics,
    openingKey: "opening_total_assets",
    closingKey: "total_assets",
    fallbackNote: warnOpeningTotalAssets,
  });
  const fixedAssetsAvg = averageWithFallback({
    metrics,
    openingKey: "opening_fixed_assets",
    closingKey: "fixed_assets",
    fallbackNote: warnOpeningFixedAssets,
  });

  const dioValue = multiply(divide(inventoriesAvg.value, costOfMaterials), 365);
  const dsoValue = multiply(divide(receivablesAvg.value, revenue), 365);
  const dpoValue = multiply(divide(payablesAvg.value, costOfMaterials), 365);

  activityEfficiencyRatios.inventoryTurnoverRatio = buildRatio(
    divide(costOfMaterials, inventoriesAvg.value),
    "cost_of_materials_consumed / average_inventories",
    [...inventoriesAvg.missingFields, ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : [])],
    inventoriesAvg.notes,
  );
  activityEfficiencyRatios.daysInventoryOutstanding = buildRatio(
    dioValue,
    "(average_inventories / cost_of_materials_consumed) * 365",
    [...inventoriesAvg.missingFields, ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : [])],
    inventoriesAvg.notes,
  );
  activityEfficiencyRatios.receivablesTurnoverRatio = buildRatio(
    divide(revenue, receivablesAvg.value),
    "revenue_from_operations / average_trade_receivables",
    [...receivablesAvg.missingFields, ...(revenue === null ? ["revenue_from_operations"] : [])],
    receivablesAvg.notes,
  );
  activityEfficiencyRatios.daysSalesOutstanding = buildRatio(
    dsoValue,
    "(average_trade_receivables / revenue_from_operations) * 365",
    [...receivablesAvg.missingFields, ...(revenue === null ? ["revenue_from_operations"] : [])],
    receivablesAvg.notes,
  );
  activityEfficiencyRatios.payablesTurnoverRatio = buildRatio(
    divide(costOfMaterials, payablesAvg.value),
    "cost_of_materials_consumed / average_trade_payables",
    [...payablesAvg.missingFields, ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : [])],
    payablesAvg.notes,
  );
  activityEfficiencyRatios.daysPayablesOutstanding = buildRatio(
    dpoValue,
    "(average_trade_payables / cost_of_materials_consumed) * 365",
    [...payablesAvg.missingFields, ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : [])],
    payablesAvg.notes,
  );
  activityEfficiencyRatios.assetTurnoverRatio = buildRatio(
    divide(revenue, totalAssetsAvg.value),
    "revenue_from_operations / average_total_assets",
    [...totalAssetsAvg.missingFields, ...(revenue === null ? ["revenue_from_operations"] : [])],
    totalAssetsAvg.notes,
  );
  activityEfficiencyRatios.fixedAssetTurnoverRatio = buildRatio(
    divide(revenue, fixedAssetsAvg.value),
    "revenue_from_operations / average_fixed_assets",
    [...fixedAssetsAvg.missingFields, ...(revenue === null ? ["revenue_from_operations"] : [])],
    fixedAssetsAvg.notes,
  );
  const wc = metrics.working_capital ?? null;
  activityEfficiencyRatios.workingCapitalTurnover = buildRatio(
    divide(revenue, wc),
    "revenue_from_operations / working_capital",
    getMissingMetricNames([
      { key: "revenue_from_operations", value: revenue },
      { key: "working_capital", value: wc },
    ]),
    [
      "working_capital = current_assets - current_liabilities (derived from line items or totals when needed).",
    ],
  );
  activityEfficiencyRatios.operatingCycleDays = buildRatio(
    dioValue !== null && dsoValue !== null ? dioValue + dsoValue : null,
    "DIO + DSO = (average_inventories / cost_of_materials_consumed) * 365 + (average_trade_receivables / revenue_from_operations) * 365",
    [
      ...inventoriesAvg.missingFields,
      ...receivablesAvg.missingFields,
      ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : []),
      ...(revenue === null ? ["revenue_from_operations"] : []),
    ],
    [
      "⚠️ REQUIRES ADDITIONAL DATA: opening_inventories, opening_trade_receivables (for averages).",
      ...inventoriesAvg.notes,
      ...receivablesAvg.notes,
    ],
  );
  activityEfficiencyRatios.cashConversionCycle = buildRatio(
    dioValue !== null && dsoValue !== null && dpoValue !== null
      ? dioValue + dsoValue - dpoValue
      : null,
    "DIO + DSO - DPO",
    [
      ...inventoriesAvg.missingFields,
      ...receivablesAvg.missingFields,
      ...payablesAvg.missingFields,
      ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : []),
      ...(revenue === null ? ["revenue_from_operations"] : []),
    ],
    [
      "⚠️ REQUIRES ADDITIONAL DATA: opening_inventories, opening_trade_receivables, opening_trade_payables (for averages).",
      "Full form: (average_inventories / cost_of_materials_consumed) * 365 + (average_trade_receivables / revenue_from_operations) * 365 - (average_trade_payables / cost_of_materials_consumed) * 365.",
      ...inventoriesAvg.notes,
      ...receivablesAvg.notes,
      ...payablesAvg.notes,
    ],
  );
  activityEfficiencyRatios.capitalIntensityRatio = buildRatio(
    divide(fixedAssets, revenue),
    "fixed_assets / revenue_from_operations",
    getMissingMetricNames([
      { key: "fixed_assets", value: fixedAssets },
      { key: "revenue_from_operations", value: revenue },
    ]),
    [],
  );

  const numberOfEquityShares = metrics.number_of_equity_shares ?? null;
  const dilutivePotentialShares = metrics.dilutive_potential_shares ?? null;
  const marketPricePerShare = metrics.market_price_per_share ?? null;
  const dividendsPaid = metrics.dividends_paid ?? null;
  const basicEps = divide(profitForYear, numberOfEquityShares);
  const dilutedEps = divide(
    profitForYear,
    numberOfEquityShares !== null && dilutivePotentialShares !== null
      ? numberOfEquityShares + dilutivePotentialShares
      : null,
  );
  const bookValuePerShare = divide(totalEquity, numberOfEquityShares);

  marketInvestmentRatios.earningsPerShareBasic = buildRatio(
    basicEps,
    "profit_loss_for_the_year / number_of_equity_shares",
    [profitForYear, numberOfEquityShares].some((v) => v === null)
      ? ["profit_loss_for_the_year", "number_of_equity_shares"]
      : [],
  );
  marketInvestmentRatios.earningsPerShareDiluted = buildRatio(
    dilutedEps,
    "profit_loss_for_the_year / (number_of_equity_shares + dilutive_potential_shares)",
    [profitForYear, numberOfEquityShares, dilutivePotentialShares].some(
      (v) => v === null,
    )
      ? [
          "profit_loss_for_the_year",
          "number_of_equity_shares",
          "dilutive_potential_shares",
        ]
      : [],
  );
  marketInvestmentRatios.priceToEarningsRatio = buildRatio(
    divide(marketPricePerShare, basicEps),
    "market_price_per_share / earnings_per_share",
    [marketPricePerShare, basicEps].some((v) => v === null)
      ? ["market_price_per_share", "number_of_equity_shares"]
      : [],
  );
  marketInvestmentRatios.bookValuePerShare = buildRatio(
    bookValuePerShare,
    "total_equity / number_of_equity_shares",
    [totalEquity, numberOfEquityShares].some((v) => v === null)
      ? ["total_equity", "number_of_equity_shares"]
      : [],
  );
  marketInvestmentRatios.priceToBookRatio = buildRatio(
    divide(marketPricePerShare, bookValuePerShare),
    "market_price_per_share / book_value_per_share",
    [marketPricePerShare, bookValuePerShare].some((v) => v === null)
      ? ["market_price_per_share", "number_of_equity_shares"]
      : [],
  );
  const dps = divide(dividendsPaid, numberOfEquityShares);
  marketInvestmentRatios.dividendPerShare = buildRatio(
    dps,
    "dividends_paid / number_of_equity_shares",
    [dividendsPaid, numberOfEquityShares].some((v) => v === null)
      ? ["dividends_paid", "number_of_equity_shares"]
      : [],
  );
  marketInvestmentRatios.dividendPayoutRatio = buildRatio(
    multiply(divide(dividendsPaid, profitForYear), 100),
    "(dividends_paid / profit_loss_for_the_year) * 100",
    [dividendsPaid, profitForYear].some((v) => v === null)
      ? ["dividends_paid", "profit_loss_for_the_year"]
      : [],
  );
  marketInvestmentRatios.dividendYield = buildRatio(
    multiply(divide(dps, marketPricePerShare), 100),
    "(dividend_per_share / market_price_per_share) * 100",
    [dps, marketPricePerShare].some((v) => v === null)
      ? ["market_price_per_share", "number_of_equity_shares", "dividends_paid"]
      : [],
  );
  marketInvestmentRatios.retentionRatio = buildRatio(
    multiply(
      divide(
        profitForYear !== null && dividendsPaid !== null
          ? profitForYear - dividendsPaid
          : null,
        profitForYear,
      ),
      100,
    ),
    "((profit_loss_for_the_year - dividends_paid) / profit_loss_for_the_year) * 100",
    [profitForYear, dividendsPaid].some((v) => v === null)
      ? ["profit_loss_for_the_year", "dividends_paid"]
      : [],
  );
  marketInvestmentRatios.earningsYield = buildRatio(
    multiply(divide(basicEps, marketPricePerShare), 100),
    "(earnings_per_share / market_price_per_share) * 100",
    [basicEps, marketPricePerShare].some((v) => v === null)
      ? ["market_price_per_share", "number_of_equity_shares"]
      : [],
  );

  const ocf = metrics.net_cash_from_operating_activities ?? null;
  const purchaseOfFixedAssets = metrics.purchase_of_fixed_assets ?? null;

  const ocfAbs = absMetric(ocf);
  const purchaseAbs = absMetric(purchaseOfFixedAssets);
  const currentLiabilitiesAbs = absMetric(currentLiabilities);
  const revenueAbs = absMetric(revenue);
  const totalAssetsAbs = absMetric(totalAssets);
  const totalDebtAbs = absMetric(totalDebt);
  const dividendsPaidAbs = absMetric(dividendsPaid);
  const principalRepaymentAbs = absMetric(principalRepayment);

  const cashFlowNotesAdequacyPrincipal =
    principalRepayment === null
      ? ["⚠️ REQUIRES ADDITIONAL DATA: principal_repayment (treated as 0 in denominator)."]
      : [];

  const cashFlowAbsNote =
    "Cash flow ratios use absolute values |x| for every input taken from the statements before applying the formula.";

  const adequacyDenominator =
    ocfAbs === null
      ? null
      : (purchaseAbs ?? 0) + (dividendsPaidAbs ?? 0) + (principalRepaymentAbs ?? 0);

  cashFlowRatios.operatingCashFlowRatio = buildRatio(
    divide(ocfAbs, currentLiabilitiesAbs),
    "|net_cash_from_operating_activities| / |current_liabilities|",
    getMissingMetricNames([
      { key: "net_cash_from_operating_activities", value: ocf },
      { key: "current_liabilities", value: currentLiabilities },
    ]),
    [cashFlowAbsNote],
  );
  cashFlowRatios.freeCashFlow = buildRatio(
    ocfAbs !== null ? ocfAbs - (purchaseAbs ?? 0) : null,
    "|net_cash_from_operating_activities| - |purchase_of_fixed_assets|",
    getMissingMetricNames([
      { key: "net_cash_from_operating_activities", value: ocf },
    ]),
    [
      "Amount in ₹; purchase_of_fixed_assets treated as 0 if not extracted.",
      cashFlowAbsNote,
    ],
  );
  cashFlowRatios.cashFlowToRevenueRatio = buildRatio(
    multiply(divide(ocfAbs, revenueAbs), 100),
    "(|net_cash_from_operating_activities| / |revenue_from_operations|) * 100",
    getMissingMetricNames([
      { key: "net_cash_from_operating_activities", value: ocf },
      { key: "revenue_from_operations", value: revenue },
    ]),
    [cashFlowAbsNote],
  );
  cashFlowRatios.cashReturnOnAssets = buildRatio(
    multiply(divide(ocfAbs, totalAssetsAbs), 100),
    "(|net_cash_from_operating_activities| / |total_assets|) * 100",
    getMissingMetricNames([
      { key: "net_cash_from_operating_activities", value: ocf },
      { key: "total_assets", value: totalAssets },
    ]),
    [cashFlowAbsNote],
  );
  cashFlowRatios.cashFlowCoverageRatio = buildRatio(
    divide(ocfAbs, totalDebtAbs),
    "|net_cash_from_operating_activities| / |total_debt|",
    getMissingMetricNames([
      { key: "net_cash_from_operating_activities", value: ocf },
      { key: "total_debt", value: totalDebt },
    ]),
    [
      "Note: total_debt may be derived from long_term_borrowings + short_term_borrowings.",
      cashFlowAbsNote,
    ],
  );
  cashFlowRatios.cashFlowToDebtRatio = buildRatio(
    divide(ocfAbs, totalDebtAbs),
    "|net_cash_from_operating_activities| / |total_debt|",
    getMissingMetricNames([
      { key: "net_cash_from_operating_activities", value: ocf },
      { key: "total_debt", value: totalDebt },
    ]),
    ["Same inputs as 6.5; label distinguishes coverage naming in reporting.", cashFlowAbsNote],
  );
  cashFlowRatios.cashFlowAdequacyRatio = buildRatio(
    divide(
      ocfAbs,
      adequacyDenominator !== null && adequacyDenominator !== 0
        ? adequacyDenominator
        : null,
    ),
    "|net_cash_from_operating_activities| / (|purchase_of_fixed_assets| + |dividends_paid| + |principal_repayment|)",
    getMissingMetricNames([{ key: "net_cash_from_operating_activities", value: ocf }]),
    [
      "Denominator treats missing purchase_of_fixed_assets, dividends_paid, or principal_repayment as 0 when summing.",
      cashFlowAbsNote,
      ...cashFlowNotesAdequacyPrincipal,
    ],
  );

  const netProfitMargin = divide(profitForYear, revenue);
  const assetTurnover = divide(revenue, totalAssets);
  const equityMultiplier = divide(totalAssets, totalEquity);
  const taxBurden = divide(profitForYear, pbt);
  const interestBurden = divide(
    pbt,
    pbt !== null && interestExpense !== null ? pbt + interestExpense : null,
  );
  const operatingMargin = divide(
    pbt !== null && interestExpense !== null ? pbt + interestExpense : null,
    revenue,
  );

  dupontAnalysis.dupontRoe3Way = buildRatio(
    netProfitMargin !== null && assetTurnover !== null && equityMultiplier !== null
      ? netProfitMargin * assetTurnover * equityMultiplier
      : null,
    "Net Profit Margin * Asset Turnover * Equity Multiplier = (profit_loss_for_the_year / revenue_from_operations) * (revenue_from_operations / total_assets) * (total_assets / total_equity)",
    getMissingMetricNames([
      { key: "profit_loss_for_the_year", value: profitForYear },
      { key: "revenue_from_operations", value: revenue },
      { key: "total_assets", value: totalAssets },
      { key: "total_equity", value: totalEquity },
    ]),
    [
      "Net Profit Margin = profit_loss_for_the_year / revenue_from_operations",
      "Asset Turnover = revenue_from_operations / total_assets",
      "Equity Multiplier = total_assets / total_equity",
    ],
  );
  dupontAnalysis.dupontRoe5Way = buildRatio(
    taxBurden !== null &&
      interestBurden !== null &&
      operatingMargin !== null &&
      assetTurnover !== null &&
      equityMultiplier !== null
      ? taxBurden *
          interestBurden *
          operatingMargin *
          assetTurnover *
          equityMultiplier
      : null,
    "Tax Burden * Interest Burden * Operating Margin * Asset Turnover * Equity Multiplier = (profit_loss_for_the_year / net_profit_before_taxation) * (net_profit_before_taxation / (net_profit_before_taxation + interest_expense)) * ((net_profit_before_taxation + interest_expense) / revenue_from_operations) * (revenue_from_operations / total_assets) * (total_assets / total_equity)",
    getMissingMetricNames([
      { key: "profit_loss_for_the_year", value: profitForYear },
      { key: "net_profit_before_taxation", value: pbt },
      { key: "interest_expense", value: interestExpense },
      { key: "revenue_from_operations", value: revenue },
      { key: "total_assets", value: totalAssets },
      { key: "total_equity", value: totalEquity },
    ]),
    [
      "Tax Burden = profit_loss_for_the_year / net_profit_before_taxation",
      "Interest Burden = net_profit_before_taxation / (net_profit_before_taxation + interest_expense)",
      "Operating Margin (EBIT Margin) = (net_profit_before_taxation + interest_expense) / revenue_from_operations",
      "Asset Turnover = revenue_from_operations / total_assets",
      "Equity Multiplier = total_assets / total_equity",
    ],
  );

  const variableCosts = metrics.variable_costs ?? null;
  const contributionMargin =
    revenue !== null && variableCosts !== null
      ? revenue - variableCosts
      : revenue !== null && costOfMaterials !== null
        ? revenue - costOfMaterials
        : null;
  const operatingProfitForLeverage =
    pbt !== null && interestExpense !== null ? pbt + interestExpense : null;
  const dol = divide(contributionMargin, operatingProfitForLeverage);
  const dolFormula =
    variableCosts !== null
      ? "(revenue_from_operations - variable_costs) / (net_profit_before_taxation + interest_expense)"
      : "(revenue_from_operations - cost_of_materials_consumed) / (net_profit_before_taxation + interest_expense)";
  const dolMissing =
    variableCosts !== null
      ? getMissingMetricNames([
          { key: "revenue_from_operations", value: revenue },
          { key: "variable_costs", value: variableCosts },
          { key: "net_profit_before_taxation", value: pbt },
          { key: "interest_expense", value: interestExpense },
        ])
      : getMissingMetricNames([
          { key: "revenue_from_operations", value: revenue },
          { key: "cost_of_materials_consumed", value: costOfMaterials },
          { key: "net_profit_before_taxation", value: pbt },
          { key: "interest_expense", value: interestExpense },
        ]);
  const dolNotes =
    variableCosts === null
      ? [
          "⚠️ REQUIRES ADDITIONAL DATA: Breakdown of fixed and variable costs.",
          "Alternative approximation: (revenue_from_operations - cost_of_materials_consumed) / (net_profit_before_taxation + interest_expense).",
        ]
      : [
          "Contribution margin = revenue_from_operations - variable_costs (variable_costs extracted).",
        ];
  const dfl = divide(operatingProfitForLeverage, pbt);
  const dflMissing = getMissingMetricNames([
    { key: "net_profit_before_taxation", value: pbt },
    { key: "interest_expense", value: interestExpense },
  ]);
  const dclMissing =
    dol === null || dfl === null
      ? Array.from(new Set([...dolMissing, ...dflMissing]))
      : [];

  leverageAnalysis.degreeOfOperatingLeverage = buildRatio(
    dol,
    `contribution_margin / operating_profit = ${dolFormula}`,
    dolMissing,
    dolNotes,
  );
  leverageAnalysis.degreeOfFinancialLeverage = buildRatio(
    dfl,
    "EBIT / EBT = (net_profit_before_taxation + interest_expense) / net_profit_before_taxation",
    dflMissing,
    [
      "EBIT = net_profit_before_taxation + interest_expense; EBT = net_profit_before_taxation (DFL = EBIT / EBT).",
    ],
  );
  leverageAnalysis.degreeOfCombinedLeverage = buildRatio(
    dol !== null && dfl !== null ? dol * dfl : null,
    "DOL * DFL",
    dclMissing,
    variableCosts === null
      ? [
          "⚠️ REQUIRES ADDITIONAL DATA: Fixed and variable cost breakdown for accurate DOL (DCL uses approximated DOL when variable costs are not split).",
        ]
      : [],
  );

  const currentTax = metrics.current_tax ?? null;
  const deferredTax = metrics.deferred_tax ?? null;
  const hasTaxComponents =
    (currentTax !== null && currentTax !== undefined && Number.isFinite(currentTax)) ||
    (deferredTax !== null && deferredTax !== undefined && Number.isFinite(deferredTax));
  const taxSumStatutory = hasTaxComponents
    ? (currentTax ?? 0) + (deferredTax ?? 0)
    : null;
  let taxExpenseResolved = metrics.tax_expense ?? null;
  if (
    (taxExpenseResolved === null || taxExpenseResolved === undefined) &&
    hasTaxComponents
  ) {
    taxExpenseResolved = (currentTax ?? 0) + (deferredTax ?? 0);
  }
  const employeeBenefitsExpense = metrics.employee_benefits_expense ?? null;
  const financeCosts = metrics.finance_costs ?? null;
  const otherExpenses = metrics.other_expenses ?? null;
  const ppeForCwip =
    metrics.property_plant_equipment ??
    metrics.property_plant_and_equipment ??
    null;
  const interestIncome = metrics.interest_income ?? null;

  otherImportantRatios.taxRate = buildRatio(
    multiply(divide(taxSumStatutory, pbt), 100),
    "((current_tax + deferred_tax) / net_profit_before_taxation) * 100",
    [
      ...getMissingMetricNames([{ key: "net_profit_before_taxation", value: pbt }]),
      ...(hasTaxComponents ? [] : ["current_tax", "deferred_tax"]),
    ],
  );
  otherImportantRatios.effectiveTaxRate = buildRatio(
    multiply(divide(taxExpenseResolved, pbt), 100),
    "(tax_expense / net_profit_before_taxation) * 100",
    getMissingMetricNames([
      { key: "tax_expense", value: taxExpenseResolved },
      { key: "net_profit_before_taxation", value: pbt },
    ]),
    [
      "Note: tax_expense should equal current_tax + deferred_tax when both are present; otherwise tax_expense from the statement is used, or current_tax + deferred_tax when tax_expense is missing.",
    ],
  );
  otherImportantRatios.employeeCostToRevenueRatio = buildRatio(
    multiply(divide(employeeBenefitsExpense, revenue), 100),
    "(employee_benefits_expense / revenue_from_operations) * 100",
    [employeeBenefitsExpense, revenue].some((v) => v === null)
      ? ["employee_benefits_expense", "revenue_from_operations"]
      : [],
  );
  otherImportantRatios.financeCostToRevenueRatio = buildRatio(
    multiply(divide(financeCosts, revenue), 100),
    "(finance_costs / revenue_from_operations) * 100",
    [financeCosts, revenue].some((v) => v === null)
      ? ["finance_costs", "revenue_from_operations"]
      : [],
  );
  otherImportantRatios.depreciationToRevenueRatio = buildRatio(
    multiply(divide(depreciation, revenue), 100),
    "(depreciation_and_amortization_expense / revenue_from_operations) * 100",
    [depreciation, revenue].some((v) => v === null)
      ? ["depreciation_and_amortization_expense", "revenue_from_operations"]
      : [],
  );
  otherImportantRatios.otherExpensesToRevenueRatio = buildRatio(
    multiply(divide(otherExpenses, revenue), 100),
    "(other_expenses / revenue_from_operations) * 100",
    [otherExpenses, revenue].some((v) => v === null)
      ? ["other_expenses", "revenue_from_operations"]
      : [],
  );
  otherImportantRatios.capitalWorkInProgressRatio = buildRatio(
    multiply(divide(metrics.capital_work_in_progress ?? null, ppeForCwip), 100),
    "(capital_work_in_progress / property_plant_equipment) * 100",
    getMissingMetricNames([
      { key: "capital_work_in_progress", value: metrics.capital_work_in_progress ?? null },
      { key: "property_plant_equipment", value: ppeForCwip },
    ]),
    [
      "Denominator uses property_plant_equipment or property_plant_and_equipment when present.",
    ],
  );
  otherImportantRatios.interestIncomeToInterestExpenseRatio = buildRatio(
    divide(interestIncome, interestExpense),
    "interest_income / interest_expense",
    getMissingMetricNames([
      { key: "interest_income", value: interestIncome },
      { key: "interest_expense", value: interestExpense },
    ]),
    [],
  );

  attachRatioSources(profitabilityRatios, metricSources);
  attachRatioSources(liquidityRatios, metricSources);
  attachRatioSources(leverageSolvencyRatios, metricSources);
  attachRatioSources(activityEfficiencyRatios, metricSources);
  attachRatioSources(marketInvestmentRatios, metricSources);
  attachRatioSources(cashFlowRatios, metricSources);
  attachRatioSources(dupontAnalysis, metricSources);
  attachRatioSources(leverageAnalysis, metricSources);
  attachRatioSources(otherImportantRatios, metricSources);

  return {
    profitabilityRatios,
    liquidityRatios,
    leverageSolvencyRatios,
    activityEfficiencyRatios,
    marketInvestmentRatios,
    cashFlowRatios,
    dupontAnalysis,
    leverageAnalysis,
    otherImportantRatios,
  };
}
