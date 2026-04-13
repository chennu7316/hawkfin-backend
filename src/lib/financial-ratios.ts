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
  fallbackNote: string;
}) {
  const opening = params.metrics[params.openingKey];
  const closing = params.metrics[params.closingKey];

  if (opening !== null && closing !== null) {
    return {
      value: (opening + closing) / 2,
      missingFields: [] as string[],
      notes: [] as string[],
    };
  }

  if (closing !== null) {
    return {
      value: closing,
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

  const hasTotalDebt =
    metrics.total_debt !== null && metrics.total_debt !== undefined;
  const longTermBorrowings = metrics.long_term_borrowings ?? null;
  const shortTermBorrowings = metrics.short_term_borrowings ?? null;
  if (!hasTotalDebt && longTermBorrowings !== null && shortTermBorrowings !== null) {
    metrics.total_debt = longTermBorrowings + shortTermBorrowings;
    metricSources.total_debt = "derived";
  }

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

  const hasWorkingCapital =
    metrics.working_capital !== null && metrics.working_capital !== undefined;
  const currentAssets = metrics.current_assets ?? null;
  const currentLiabilities = metrics.current_liabilities ?? null;
  if (!hasWorkingCapital && currentAssets !== null && currentLiabilities !== null) {
    metrics.working_capital = currentAssets - currentLiabilities;
    metricSources.working_capital = "derived";
  }

  const hasCurrentAssets =
    metrics.current_assets !== null && metrics.current_assets !== undefined;
  const currentInvestments = metrics.current_investments ?? null;
  const inventories = metrics.inventories ?? null;
  const tradeReceivables = metrics.trade_receivables ?? null;
  const cashAndCashEquivalents = metrics.cash_and_cash_equivalents ?? null;
  const shortTermLoansAndAdvances = metrics.short_term_loans_and_advances ?? null;
  const otherCurrentAssets = metrics.other_current_assets ?? null;
  if (
    !hasCurrentAssets &&
    currentInvestments !== null &&
    inventories !== null &&
    tradeReceivables !== null &&
    cashAndCashEquivalents !== null &&
    shortTermLoansAndAdvances !== null &&
    otherCurrentAssets !== null
  ) {
    metrics.current_assets =
      currentInvestments +
      inventories +
      tradeReceivables +
      cashAndCashEquivalents +
      shortTermLoansAndAdvances +
      otherCurrentAssets;
    metricSources.current_assets = "derived";
  }

  const hasCurrentLiabilities =
    metrics.current_liabilities !== null &&
    metrics.current_liabilities !== undefined;
  const tradePayables = metrics.trade_payables ?? null;
  const otherCurrentLiabilities = metrics.other_current_liabilities ?? null;
  const shortTermProvisions = metrics.short_term_provisions ?? null;
  if (
    !hasCurrentLiabilities &&
    shortTermBorrowings !== null &&
    tradePayables !== null &&
    otherCurrentLiabilities !== null &&
    shortTermProvisions !== null
  ) {
    metrics.current_liabilities =
      shortTermBorrowings +
      tradePayables +
      otherCurrentLiabilities +
      shortTermProvisions;
    metricSources.current_liabilities = "derived";
  }

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
        totalEquity !== null && longTermBorrowings !== null
          ? totalEquity + longTermBorrowings
          : null,
      ),
      100,
    ),
    "((net_profit_before_taxation + interest_expense) / (total_equity + long_term_borrowings)) * 100",
    getMissingMetricNames([
      { key: "net_profit_before_taxation", value: pbt },
      { key: "interest_expense", value: interestExpense },
      { key: "total_equity", value: totalEquity },
      { key: "long_term_borrowings", value: longTermBorrowings },
    ]),
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

  liquidityRatios.currentRatio = buildRatio(
    divide(currentAssets, currentLiabilities),
    "current_assets / current_liabilities",
    [currentAssets, currentLiabilities].some((v) => v === null)
      ? ["current_assets", "current_liabilities"]
      : [],
  );
  liquidityRatios.quickRatio = buildRatio(
    divide(
      currentAssets !== null && inventories !== null
        ? currentAssets - inventories
        : null,
      currentLiabilities,
    ),
    "(current_assets - inventories) / current_liabilities",
    [currentAssets, inventories, currentLiabilities].some((v) => v === null)
      ? ["current_assets", "inventories", "current_liabilities"]
      : [],
  );
  liquidityRatios.cashRatio = buildRatio(
    divide(
      cashAndCashEquivalents !== null && shortTermInvestments !== null
        ? cashAndCashEquivalents + shortTermInvestments
        : null,
      currentLiabilities,
    ),
    "(cash_and_cash_equivalents + short-term_investments) / current_liabilities",
    [cashAndCashEquivalents, shortTermInvestments, currentLiabilities].some(
      (v) => v === null,
    )
      ? [
          "cash_and_cash_equivalents",
          "short-term_investments",
          "current_liabilities",
        ]
      : [],
  );
  liquidityRatios.absoluteLiquidRatio = buildRatio(
    divide(cashAndCashEquivalents, currentLiabilities),
    "cash_and_cash_equivalents / current_liabilities",
    [cashAndCashEquivalents, currentLiabilities].some((v) => v === null)
      ? ["cash_and_cash_equivalents", "current_liabilities"]
      : [],
  );

  leverageSolvencyRatios.debtToEquityRatio = buildRatio(
    divide(totalDebt, totalEquity),
    "total_debt / total_equity",
    [totalDebt, totalEquity].some((v) => v === null)
      ? ["total_debt", "total_equity"]
      : [],
  );
  leverageSolvencyRatios.debtRatio = buildRatio(
    divide(totalDebt, totalAssets),
    "total_debt / total_assets",
    [totalDebt, totalAssets].some((v) => v === null)
      ? ["total_debt", "total_assets"]
      : [],
  );
  leverageSolvencyRatios.equityRatio = buildRatio(
    divide(totalEquity, totalAssets),
    "total_equity / total_assets",
    [totalEquity, totalAssets].some((v) => v === null)
      ? ["total_equity", "total_assets"]
      : [],
  );
  leverageSolvencyRatios.interestCoverageRatio = buildRatio(
    divide(
      pbt !== null && interestExpense !== null ? pbt + interestExpense : null,
      interestExpense,
    ),
    "(net_profit_before_taxation + interest_expense) / interest_expense",
    [pbt, interestExpense].some((v) => v === null)
      ? ["net_profit_before_taxation", "interest_expense"]
      : [],
  );
  leverageSolvencyRatios.debtServiceCoverageRatio = buildRatio(
    divide(
      pbt !== null && depreciation !== null && interestExpense !== null
        ? pbt + depreciation + interestExpense
        : null,
      interestPaid !== null && principalRepayment !== null
        ? interestPaid + principalRepayment
        : null,
    ),
    "(net_profit_before_taxation + depreciation_and_amortization_expense + interest_expense) / (interest_paid + principal_repayment)",
    [pbt, depreciation, interestExpense, interestPaid, principalRepayment].some(
      (v) => v === null,
    )
      ? [
          "net_profit_before_taxation",
          "depreciation_and_amortization_expense",
          "interest_expense",
          "interest_paid",
          "principal_repayment",
        ]
      : [],
    principalRepayment === null
      ? ["Requires additional data: principal_repayment."]
      : [],
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

  const inventoriesAvg = averageWithFallback({
    metrics,
    openingKey: "opening_inventories",
    closingKey: "inventories",
    fallbackNote:
      "Opening inventory not found. Used closing inventories as an alternative.",
  });
  const receivablesAvg = averageWithFallback({
    metrics,
    openingKey: "opening_trade_receivables",
    closingKey: "trade_receivables",
    fallbackNote:
      "Opening trade receivables not found. Used closing trade receivables as an alternative.",
  });
  const payablesAvg = averageWithFallback({
    metrics,
    openingKey: "opening_trade_payables",
    closingKey: "trade_payables",
    fallbackNote:
      "Opening trade payables not found. Used closing trade payables as an alternative.",
  });
  const totalAssetsAvg = averageWithFallback({
    metrics,
    openingKey: "opening_total_assets",
    closingKey: "total_assets",
    fallbackNote:
      "Opening total assets not found. Used closing total assets as an alternative.",
  });
  const fixedAssetsAvg = averageWithFallback({
    metrics,
    openingKey: "opening_fixed_assets",
    closingKey: "fixed_assets",
    fallbackNote:
      "Opening fixed assets not found. Used closing fixed assets as an alternative.",
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
  activityEfficiencyRatios.workingCapitalTurnover = buildRatio(
    divide(revenue, metrics.working_capital ?? null),
    "revenue_from_operations / working_capital",
    [revenue, metrics.working_capital ?? null].some((v) => v === null)
      ? ["revenue_from_operations", "working_capital"]
      : [],
  );
  activityEfficiencyRatios.operatingCycleDays = buildRatio(
    dioValue !== null && dsoValue !== null ? dioValue + dsoValue : null,
    "DIO + DSO",
    [
      ...inventoriesAvg.missingFields,
      ...receivablesAvg.missingFields,
      ...(costOfMaterials === null ? ["cost_of_materials_consumed"] : []),
      ...(revenue === null ? ["revenue_from_operations"] : []),
    ],
    [...inventoriesAvg.notes, ...receivablesAvg.notes],
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
    [...inventoriesAvg.notes, ...receivablesAvg.notes, ...payablesAvg.notes],
  );
  activityEfficiencyRatios.capitalIntensityRatio = buildRatio(
    divide(fixedAssets, revenue),
    "fixed_assets / revenue_from_operations",
    [fixedAssets, revenue].some((v) => v === null)
      ? ["fixed_assets", "revenue_from_operations"]
      : [],
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

  cashFlowRatios.operatingCashFlowRatio = buildRatio(
    divide(ocf, metrics.current_liabilities ?? null),
    "net_cash_from_operating_activities / current_liabilities",
    [ocf, metrics.current_liabilities ?? null].some((v) => v === null)
      ? ["net_cash_from_operating_activities", "current_liabilities"]
      : [],
  );
  cashFlowRatios.freeCashFlow = buildRatio(
    ocf !== null && purchaseOfFixedAssets !== null
      ? ocf - purchaseOfFixedAssets
      : null,
    "net_cash_from_operating_activities - purchase_of_fixed_assets",
    [ocf, purchaseOfFixedAssets].some((v) => v === null)
      ? ["net_cash_from_operating_activities", "purchase_of_fixed_assets"]
      : [],
  );
  cashFlowRatios.cashFlowToRevenueRatio = buildRatio(
    multiply(divide(ocf, revenue), 100),
    "(net_cash_from_operating_activities / revenue_from_operations) * 100",
    [ocf, revenue].some((v) => v === null)
      ? ["net_cash_from_operating_activities", "revenue_from_operations"]
      : [],
  );
  cashFlowRatios.cashReturnOnAssets = buildRatio(
    multiply(divide(ocf, totalAssets), 100),
    "(net_cash_from_operating_activities / total_assets) * 100",
    [ocf, totalAssets].some((v) => v === null)
      ? ["net_cash_from_operating_activities", "total_assets"]
      : [],
  );
  cashFlowRatios.cashFlowCoverageRatio = buildRatio(
    divide(ocf, totalDebt),
    "net_cash_from_operating_activities / total_debt",
    [ocf, totalDebt].some((v) => v === null)
      ? ["net_cash_from_operating_activities", "total_debt"]
      : [],
  );
  cashFlowRatios.cashFlowToDebtRatio = buildRatio(
    divide(ocf, totalDebt),
    "net_cash_from_operating_activities / total_debt",
    [ocf, totalDebt].some((v) => v === null)
      ? ["net_cash_from_operating_activities", "total_debt"]
      : [],
  );
  cashFlowRatios.cashFlowAdequacyRatio = buildRatio(
    divide(
      ocf,
      purchaseOfFixedAssets !== null &&
        dividendsPaid !== null &&
        principalRepayment !== null
        ? purchaseOfFixedAssets + dividendsPaid + principalRepayment
        : null,
    ),
    "net_cash_from_operating_activities / (purchase_of_fixed_assets + dividends_paid + principal_repayment)",
    [ocf, purchaseOfFixedAssets, dividendsPaid, principalRepayment].some(
      (v) => v === null,
    )
      ? [
          "net_cash_from_operating_activities",
          "purchase_of_fixed_assets",
          "dividends_paid",
          "principal_repayment",
        ]
      : [],
    principalRepayment === null
      ? ["Requires additional data: principal_repayment."]
      : [],
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
    "(profit_loss_for_the_year / revenue_from_operations) * (revenue_from_operations / total_assets) * (total_assets / total_equity)",
    [netProfitMargin, assetTurnover, equityMultiplier].some((v) => v === null)
      ? ["profit_loss_for_the_year", "revenue_from_operations", "total_assets", "total_equity"]
      : [],
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
    "Tax Burden * Interest Burden * Operating Margin * Asset Turnover * Equity Multiplier",
    [taxBurden, interestBurden, operatingMargin, assetTurnover, equityMultiplier].some(
      (v) => v === null,
    )
      ? ["profit_loss_for_the_year", "net_profit_before_taxation", "interest_expense", "revenue_from_operations", "total_assets", "total_equity"]
      : [],
  );

  const contributionApprox =
    revenue !== null && costOfMaterials !== null ? revenue - costOfMaterials : null;
  const operatingProfit =
    pbt !== null && interestExpense !== null ? pbt + interestExpense : null;
  const dol = divide(contributionApprox, operatingProfit);
  const dfl = divide(operatingProfit, pbt);

  leverageAnalysis.degreeOfOperatingLeverage = buildRatio(
    dol,
    "(revenue_from_operations - cost_of_materials_consumed) / (net_profit_before_taxation + interest_expense)",
    [revenue, costOfMaterials, pbt, interestExpense].some((v) => v === null)
      ? [
          "revenue_from_operations",
          "cost_of_materials_consumed",
          "net_profit_before_taxation",
          "interest_expense",
        ]
      : [],
    ["Approximation used due to missing variable_costs breakdown."],
  );
  leverageAnalysis.degreeOfFinancialLeverage = buildRatio(
    dfl,
    "(net_profit_before_taxation + interest_expense) / net_profit_before_taxation",
    [pbt, interestExpense].some((v) => v === null)
      ? ["net_profit_before_taxation", "interest_expense"]
      : [],
  );
  leverageAnalysis.degreeOfCombinedLeverage = buildRatio(
    dol !== null && dfl !== null ? dol * dfl : null,
    "DOL * DFL",
    [dol, dfl].some((v) => v === null)
      ? [
          "revenue_from_operations",
          "cost_of_materials_consumed",
          "net_profit_before_taxation",
          "interest_expense",
        ]
      : [],
    ["Based on approximated DOL."],
  );

  const currentTax = metrics.current_tax ?? null;
  const deferredTax = metrics.deferred_tax ?? null;
  const taxExpense = metrics.tax_expense ?? null;
  const employeeBenefitsExpense = metrics.employee_benefits_expense ?? null;
  const financeCosts = metrics.finance_costs ?? null;
  const otherExpenses = metrics.other_expenses ?? null;
  const ppeForCwip =
    metrics.property_plant_equipment ??
    metrics.property_plant_and_equipment ??
    null;
  const interestIncome = metrics.interest_income ?? null;

  otherImportantRatios.taxRate = buildRatio(
    multiply(
      divide(
        currentTax !== null && deferredTax !== null
          ? currentTax + deferredTax
          : null,
        pbt,
      ),
      100,
    ),
    "((current_tax + deferred_tax) / net_profit_before_taxation) * 100",
    [currentTax, deferredTax, pbt].some((v) => v === null)
      ? ["current_tax", "deferred_tax", "net_profit_before_taxation"]
      : [],
  );
  otherImportantRatios.effectiveTaxRate = buildRatio(
    multiply(divide(taxExpense, pbt), 100),
    "(tax_expense / net_profit_before_taxation) * 100",
    [taxExpense, pbt].some((v) => v === null)
      ? ["tax_expense", "net_profit_before_taxation"]
      : [],
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
    "(capital_work_in_progress / property,_plant_&_equipment) * 100",
    [metrics.capital_work_in_progress ?? null, ppeForCwip].some((v) => v === null)
      ? ["capital_work_in_progress", "property,_plant_&_equipment"]
      : [],
  );
  otherImportantRatios.interestIncomeToInterestExpenseRatio = buildRatio(
    divide(interestIncome, interestExpense),
    "interest_income / interest_expense",
    [interestIncome, interestExpense].some((v) => v === null)
      ? ["interest_income", "interest_expense"]
      : [],
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
