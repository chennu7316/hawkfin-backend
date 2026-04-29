import { Storage, type File as GcsFile } from "@google-cloud/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import pool from "../lib/db.js";
import {
  computeFinancialRatios,
  extractFinancialMetricsFromEntities,
} from "../lib/financial-ratios.js";

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

const allowedExtensions = new Set(["pdf", "docx", "xlsx", "xls"]);
const docxMimeType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const xlsxMimeType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const xlsMimeType = "application/vnd.ms-excel";
const pdfMimeType = "application/pdf";

const validYears = new Set([
  "2026",
  "2025",
  "2024",
  "2023",
  "2022",
  "2021",
  "2020",
  "2019",
  "2018",
  "2017",
  "2016",
  "2015",
  "2014",
  "2013",
  "2012",
  "2011",
]);

const retryableStorageErrorCodes = new Set([
  "EPIPE",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
const profitabilityFormulaNames = [
  "grossProfitRatio",
  "netProfitRatio",
  "operatingProfitRatio",
  "returnOnAssets",
  "returnOnEquity",
  "returnOnCapitalEmployed",
  "ebitdaMargin",
  "ebitMargin",
] as const;

const liquidityFormulaNames = [
  "currentRatio",
  "quickRatio",
  "cashRatio",
  "absoluteLiquidRatio",
] as const;

const leverageSolvencyFormulaNames = [
  "debtToEquityRatio",
  "debtRatio",
  "equityRatio",
  "interestCoverageRatio",
  "debtServiceCoverageRatio",
] as const;

const cashFlowFormulaNames = [
  "operatingCashFlowRatio",
  "freeCashFlow",
  "cashFlowToRevenueRatio",
  "cashReturnOnAssets",
  "cashFlowCoverageRatio",
  "cashFlowToDebtRatio",
  "cashFlowAdequacyRatio",
] as const;

const dupontFormulaNames = ["dupontRoe3Way", "dupontRoe5Way"] as const;

const leverageAnalysisFormulaNames = [
  "degreeOfOperatingLeverage",
  "degreeOfFinancialLeverage",
  "degreeOfCombinedLeverage",
] as const;

const otherImportantFormulaNames = [
  "taxRate",
  "effectiveTaxRate",
  "employeeCostToRevenueRatio",
  "financeCostToRevenueRatio",
  "depreciationToRevenueRatio",
  "otherExpensesToRevenueRatio",
  "capitalWorkInProgressRatio",
  "interestIncomeToInterestExpenseRatio",
] as const;

const activityEfficiencyFormulaNames = [
  "inventoryTurnoverRatio",
  "daysInventoryOutstanding",
  "receivablesTurnoverRatio",
  "daysSalesOutstanding",
  "payablesTurnoverRatio",
  "daysPayablesOutstanding",
  "assetTurnoverRatio",
  "fixedAssetTurnoverRatio",
  "workingCapitalTurnover",
  "operatingCycleDays",
  "cashConversionCycle",
  "capitalIntensityRatio",
] as const;

export type DocAiEntityPropertyDetail = {
  type: string;
  mentionText: string;
  confidence: number | null;
};

export type DocAiEntityDetail = {
  type: string;
  mentionText: string;
  confidence: number | null;
  properties: DocAiEntityPropertyDetail[];
};

export type ExtractionResult = {
  processorName: string | null;
  status: "completed" | "failed" | "skipped";
  error: string | null;
  revenueFromOperation: number | null;
  costOfMaterialConsumed: number | null;
  entities: Array<{ type: string; mentionText: string }>;
  /** Full Document AI entity payload (confidence + nested properties) for auditing. */
  docAiEntitiesDetailed?: DocAiEntityDetail[] | null;
  /** OCR / layout text length when returned by Document AI. */
  documentTextLength?: number | null;
  yearAmountPairs: Record<
    string,
    Array<{
      year: string | null;
      amount: number | null;
    }>
  >;
  metrics: Record<string, number | null>;
  metricSources: Record<string, "document" | "alias" | "derived">;
  ratios: ReturnType<typeof computeFinancialRatios> | null;
};

export type StatementHistoryItem = {
  id: string;
  userId: string | null;
  companyId: string;
  companyName: string;
  yearEnding: string;
  filePath: string;
  gcsUri: string;
  originalFileName: string;
  extractionStatus: string;
  analysisResults: Record<string, unknown> | null;
  createdAt: string;
};

function getExtension(filename: string) {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toPdfFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "") + ".pdf";
}

function isDocxUpload(file: File, ext: string) {
  return ext === "docx" || file.type === docxMimeType;
}

function isExcelUpload(file: File, ext: string) {
  return (
    ext === "xlsx" ||
    ext === "xls" ||
    file.type === xlsxMimeType ||
    file.type === xlsMimeType
  );
}

async function convertOfficeToPdfBuffer(sourceBuffer: Buffer, originalName: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "office-to-pdf-"));
  const sourceName = sanitizeFileName(originalName) || "source";
  const sourcePath = path.join(tempDir, sourceName);
  const outputFileName = toPdfFileName(sourceName);
  const outputPath = path.join(tempDir, outputFileName);

  try {
    await fs.writeFile(sourcePath, sourceBuffer);

    await new Promise<void>((resolve, reject) => {
      execFile(
        "soffice",
        ["--headless", "--convert-to", "pdf", "--outdir", tempDir, sourcePath],
        { timeout: 120_000 },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });

    return await fs.readFile(outputPath);
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException;
    if (maybeErr?.code === "ENOENT") {
      throw new Error(
        "Office to PDF conversion failed: LibreOffice (soffice) is not installed on the server.",
      );
    }
    throw new Error(
      error instanceof Error
        ? `Office to PDF conversion failed: ${error.message}`
        : "Office to PDF conversion failed.",
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStorageError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode !== "string") return false;
  return retryableStorageErrorCodes.has(maybeCode.toUpperCase());
}

function parseAmount(raw: string) {
  const normalized = raw
    .replace(/[,\s]/g, "")
    .replace(/^\((.+)\)$/, "-$1")
    .replace(/[^0-9.-]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function extractYear(raw: string) {
  const match = raw.match(/(?:19|20)\d{2}/);
  return match ? match[0] : null;
}

function parseGcsUri(uri: string) {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], objectName: match[2] };
}

function buildYearAmountPairs(
  rawEntities: Array<{
    type?: string | null;
    properties?: Array<{ type?: string | null; mentionText?: string | null }> | null;
  }>,
) {
  const grouped = new Map<string, { years: string[]; amounts: number[] }>();

  for (const entity of rawEntities) {
    const type = String(entity.type ?? "").trim();
    if (!type) continue;

    const bucket = grouped.get(type) ?? { years: [], amounts: [] };
    for (const property of entity.properties ?? []) {
      const propType = String(property.type ?? "").toLowerCase();
      const mentionText = String(property.mentionText ?? "").trim();
      if (!mentionText) continue;

      if (propType === "year" || propType.includes("year") || propType.includes("date")) {
        const year = extractYear(mentionText);
        if (year) bucket.years.push(year);
      }

      if (propType === "amount" || propType.includes("amount") || propType.includes("value")) {
        const amount = parseAmount(mentionText);
        if (amount !== null) bucket.amounts.push(amount);
      }
    }
    grouped.set(type, bucket);
  }

  const result: Record<string, Array<{ year: string | null; amount: number | null }>> = {};
  for (const [type, bucket] of grouped.entries()) {
    const size = Math.max(bucket.years.length, bucket.amounts.length);
    result[type] = Array.from({ length: size }, (_, index) => ({
      year: bucket.years[index] ?? null,
      amount: bucket.amounts[index] ?? null,
    }));
  }

  return result;
}

function buildSelectedAndRemainingByYear(
  yearAmountPairs: Record<string, Array<{ year: string | null; amount: number | null }>>,
  selectedYear: string,
) {
  const selectedYearValue = selectedYear.trim();
  const result: Record<
    string,
    {
      selectedYear: string;
      selectedYearAmount: number | null;
      remaining: Array<{ year: string | null; amount: number | null }>;
    }
  > = {};

  for (const [metric, pairs] of Object.entries(yearAmountPairs)) {
    const selected = pairs.find((pair) => pair.year === selectedYearValue) ?? null;
    const remaining = pairs.filter((pair) => pair.year !== selectedYearValue);

    result[metric] = {
      selectedYear: selectedYearValue,
      selectedYearAmount: selected?.amount ?? null,
      remaining,
    };
  }

  return result;
}

function normalizeMetricKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function buildMetricsForSelectedYear(
  yearAmountPairs: Record<string, Array<{ year: string | null; amount: number | null }>>,
  selectedYear: string,
) {
  const selectedYearValue = selectedYear.trim();
  const metrics: Record<string, number | null> = {};
  const metricSources: Record<string, "document" | "alias" | "derived"> = {};
  const duplicateMetricWarnings: Array<{
    metric: string;
    year: string;
    values: number[];
  }> = [];

  for (const [rawMetricName, pairs] of Object.entries(yearAmountPairs)) {
    const metricName = normalizeMetricKey(rawMetricName);
    if (!metricName) continue;

    const selectedYearPairs = pairs.filter(
      (pair) => pair.year === selectedYearValue && pair.amount !== null,
    );
    const selected = selectedYearPairs[0] ?? null;
    if (!selected || selected.amount === null) continue;

    const distinctValues = Array.from(
      new Set(selectedYearPairs.map((pair) => Number(pair.amount))),
    );
    if (distinctValues.length > 1) {
      duplicateMetricWarnings.push({
        metric: metricName,
        year: selectedYearValue,
        values: distinctValues,
      });
    }

    metrics[metricName] = selected.amount;
    metricSources[metricName] = "document";
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

  return { metrics, metricSources, duplicateMetricWarnings };
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSortedYearsDesc(years: Iterable<string>) {
  return Array.from(years).sort((a, b) => Number(b) - Number(a));
}

function enrichMetricsForRatioComputation(
  rawMetrics: Record<string, number>,
  rawMetricSources: Record<string, "document" | "alias" | "derived">,
) {
  const metrics: Record<string, number> = { ...rawMetrics };
  const metricSources: Record<string, "document" | "alias" | "derived"> = {
    ...rawMetricSources,
  };

  const hasTotalEquity =
    metrics.total_equity !== null && metrics.total_equity !== undefined;
  if (!hasTotalEquity) {
    const shareCapital = metrics.share_capital ?? 0;
    const reservesAndSurplus = metrics.reserves_and_surplus ?? 0;
    const shareApplicationMoneyPendingAllotment =
      metrics.share_application_money_pending_allotment ?? 0;
    const moneyReceivedAgainstShareWarrants =
      metrics.money_received_against_share_warrants ?? 0;
    metrics.total_equity =
      shareCapital +
      reservesAndSurplus +
      shareApplicationMoneyPendingAllotment +
      moneyReceivedAgainstShareWarrants;
    metricSources.total_equity = "derived";
  }

  return { metrics, metricSources };
}

function pickStoredFinancialRatioCategories(
  ratios: ReturnType<typeof computeFinancialRatios> | null,
) {
  if (!ratios) return null;
  return {
    profitabilityRatios: ratios.profitabilityRatios,
    liquidityRatios: ratios.liquidityRatios,
    leverageSolvencyRatios: ratios.leverageSolvencyRatios,
    cashFlowRatios: ratios.cashFlowRatios,
    dupontAnalysis: ratios.dupontAnalysis,
    leverageAnalysis: ratios.leverageAnalysis,
    otherImportantRatios: ratios.otherImportantRatios,
    activityEfficiencyRatios: ratios.activityEfficiencyRatios,
  };
}

async function upsertFormulaResultsForDocument(
  documentId: string,
  ratioCategories: {
    profitabilityRatios?: Record<string, unknown>;
    liquidityRatios?: Record<string, unknown>;
    leverageSolvencyRatios?: Record<string, unknown>;
    cashFlowRatios?: Record<string, unknown>;
    dupontAnalysis?: Record<string, unknown>;
    leverageAnalysis?: Record<string, unknown>;
    otherImportantRatios?: Record<string, unknown>;
    activityEfficiencyRatios?: Record<string, unknown>;
  } | null,
) {
  if (!ratioCategories) return;

  const entries: Array<[string, unknown]> = [];
  for (const [name, value] of Object.entries(
    ratioCategories.profitabilityRatios ?? {},
  )) {
    if (
      profitabilityFormulaNames.includes(
        name as (typeof profitabilityFormulaNames)[number],
      )
    ) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(ratioCategories.liquidityRatios ?? {})) {
    if (liquidityFormulaNames.includes(name as (typeof liquidityFormulaNames)[number])) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(
    ratioCategories.leverageSolvencyRatios ?? {},
  )) {
    if (
      leverageSolvencyFormulaNames.includes(
        name as (typeof leverageSolvencyFormulaNames)[number],
      )
    ) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(ratioCategories.cashFlowRatios ?? {})) {
    if (
      cashFlowFormulaNames.includes(name as (typeof cashFlowFormulaNames)[number])
    ) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(ratioCategories.dupontAnalysis ?? {})) {
    if (dupontFormulaNames.includes(name as (typeof dupontFormulaNames)[number])) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(ratioCategories.leverageAnalysis ?? {})) {
    if (
      leverageAnalysisFormulaNames.includes(
        name as (typeof leverageAnalysisFormulaNames)[number],
      )
    ) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(ratioCategories.otherImportantRatios ?? {})) {
    if (
      otherImportantFormulaNames.includes(
        name as (typeof otherImportantFormulaNames)[number],
      )
    ) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(
    ratioCategories.activityEfficiencyRatios ?? {},
  )) {
    if (
      activityEfficiencyFormulaNames.includes(
        name as (typeof activityEfficiencyFormulaNames)[number],
      )
    ) {
      entries.push([name, value]);
    }
  }
  if (entries.length === 0) return;

  const { rows: activeFormulaRows } = await pool.query(
    `SELECT id, formula_name
     FROM formulas
     WHERE is_active = TRUE
       AND formula_name = ANY($1::text[])`,
    [entries.map(([formulaName]) => formulaName)],
  );

  const formulaIdByName = new Map<string, string>();
  for (const row of activeFormulaRows) {
    formulaIdByName.set(String(row.formula_name), String(row.id));
  }

  for (const [formulaName, ratioResultUnknown] of entries) {
    const ratioResult = ratioResultUnknown as { value: number | null };
    const formulaId = formulaIdByName.get(formulaName);
    if (!formulaId) continue;

    await pool.query(
      `INSERT INTO formula_results (
        document_id,
        formula_id,
        result_value,
        details
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (document_id, formula_id) DO UPDATE
      SET result_value = EXCLUDED.result_value,
          details = EXCLUDED.details,
          calculated_at = NOW()`,
      [documentId, formulaId, ratioResult.value, JSON.stringify(ratioResult)],
    );
  }
}

function createStorageClient() {
  const rawKey = process.env.GCS_SERVICE_ACCOUNT_KEY_JSON;
  if (!rawKey) {
    return new Storage();
  }

  const parsedKey = JSON.parse(rawKey) as {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };

  return new Storage({
    projectId: parsedKey.project_id,
    credentials: {
      client_email: parsedKey.client_email,
      private_key: parsedKey.private_key?.replace(/\\n/g, "\n"),
    },
  });
}

function createDocumentAiClient() {
  const rawKey = process.env.GCS_SERVICE_ACCOUNT_KEY_JSON;
  if (!rawKey) {
    return new DocumentProcessorServiceClient();
  }

  const parsedKey = JSON.parse(rawKey) as {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };

  return new DocumentProcessorServiceClient({
    projectId: parsedKey.project_id,
    credentials: {
      client_email: parsedKey.client_email,
      private_key: parsedKey.private_key?.replace(/\\n/g, "\n"),
    },
  });
}

function mapDocumentAiEntitiesToDetails(
  rawEntities: Array<{
    type?: string | null;
    mentionText?: string | null;
    confidence?: number | null;
    properties?: Array<{
      type?: string | null;
      mentionText?: string | null;
      confidence?: number | null;
    }> | null;
  }>,
): DocAiEntityDetail[] {
  return rawEntities.map((entity) => ({
    type: String(entity.type ?? ""),
    mentionText: String(entity.mentionText ?? ""),
    confidence:
      typeof entity.confidence === "number" && Number.isFinite(entity.confidence)
        ? entity.confidence
        : null,
    properties:
      entity.properties?.map((property) => ({
        type: String(property.type ?? ""),
        mentionText: String(property.mentionText ?? ""),
        confidence:
          typeof property.confidence === "number" &&
          Number.isFinite(property.confidence)
            ? property.confidence
            : null,
      })) ?? [],
  }));
}

/** Payload stored in `document_processing_logs.payload_json` for stage `docai_extract`. */
function buildDocumentProcessingLogPayload(params: {
  extraction: ExtractionResult;
  selectedYearData: { duplicateMetricWarnings: unknown[] };
  selectedAndRemainingByYear: unknown;
  uploadYear: string;
}): Record<string, unknown> {
  const { extraction, selectedYearData, selectedAndRemainingByYear, uploadYear } =
    params;
  return {
    uploadYear,
    processorName: extraction.processorName,
    extractionStatus: extraction.status,
    extractionError: extraction.error,
    documentTextLength: extraction.documentTextLength ?? null,
    entityCount: extraction.entities.length,
    yearAmountPairs: extraction.yearAmountPairs,
    selectedAndRemainingByYear,
    entities: extraction.entities,
    entitiesDetailed: extraction.docAiEntitiesDetailed ?? null,
    metricsExtracted: extraction.metrics,
    metricSources: extraction.metricSources,
    revenueFromOperation: extraction.revenueFromOperation,
    costOfMaterialConsumed: extraction.costOfMaterialConsumed,
    duplicateMetricWarnings: selectedYearData.duplicateMetricWarnings,
  };
}

async function saveFileToGcsWithRetry(params: {
  bucketFile: GcsFile;
  fileBuffer: Buffer;
  fileType: string;
  metadata: Record<string, string>;
}) {
  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      await params.bucketFile.save(params.fileBuffer, {
        contentType: params.fileType || undefined,
        resumable: true,
        metadata: { metadata: params.metadata },
      });
      return;
    } catch (error) {
      attempt += 1;
      if (!isRetryableStorageError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

async function extractWithDocumentAI(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<ExtractionResult> {
  if (mimeType !== "application/pdf") {
    return {
      processorName: null,
      status: "skipped",
      error: "Document AI extraction is currently enabled only for PDF.",
      revenueFromOperation: null,
      costOfMaterialConsumed: null,
      entities: [],
      yearAmountPairs: {},
      metrics: {},
      metricSources: {},
      ratios: null,
    };
  }

  const projectId = process.env.DOC_AI_PROJECT_ID;
  const location = process.env.DOC_AI_LOCATION ?? "us";
  const processorId = process.env.DOC_AI_PROCESSOR_ID;

  if (!projectId || !processorId) {
    return {
      processorName: null,
      status: "skipped",
      error: "Document AI processor is not configured.",
      revenueFromOperation: null,
      costOfMaterialConsumed: null,
      entities: [],
      yearAmountPairs: {},
      metrics: {},
      metricSources: {},
      ratios: null,
    };
  }

  const processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  try {
    const client = createDocumentAiClient();
    const [result] = await client.processDocument({
      name: processorName,
      rawDocument: {
        content: fileBuffer,
        mimeType: "application/pdf",
      },
    });

    const rawEntities = result.document?.entities ?? [];
    console.log(
      "[DocAI] processDocument success:",
      JSON.stringify(
        {
          processorName,
          entityCount: rawEntities.length,
          textLength: result.document?.text?.length ?? 0,
        },
        null,
        2,
      ),
    );

    for (const entity of rawEntities) {
      console.log(
        "[DocAI] entity:",
        JSON.stringify(
          {
            type: String(entity.type ?? ""),
            mentionText: String(entity.mentionText ?? ""),
            confidence: entity.confidence ?? null,
            properties:
              entity.properties?.map((property) => ({
                type: String(property.type ?? ""),
                mentionText: String(property.mentionText ?? ""),
                confidence: property.confidence ?? null,
              })) ?? [],
          },
          null,
          2,
        ),
      );
    }

    const yearAmountPairs = buildYearAmountPairs(rawEntities);
    console.log(
      "[DocAI] year-amount pairs:",
      JSON.stringify(yearAmountPairs, null, 2),
    );

    const docAiEntitiesDetailed = mapDocumentAiEntitiesToDetails(rawEntities);
    const documentTextLength =
      typeof result.document?.text === "string" ? result.document.text.length : null;

    const entities = rawEntities.map((entity) => ({
      type: String(entity.type ?? ""),
      mentionText: String(entity.mentionText ?? ""),
    }));

    const extracted = extractFinancialMetricsFromEntities(entities);
    const metrics = extracted.metrics;
    const metricSources = extracted.metricSources;
    const ratios = computeFinancialRatios(metrics, metricSources);
    const revenueFromOperation =
      metrics.revenue_from_operation ?? metrics.revenue_from_operations ?? null;
    const costOfMaterialConsumed =
      metrics.cost_of_material_consumed ?? metrics.cost_of_materials_consumed ?? null;

    return {
      processorName,
      status: "completed",
      error: null,
      revenueFromOperation,
      costOfMaterialConsumed,
      docAiEntitiesDetailed,
      documentTextLength,
      entities,
      yearAmountPairs,
      metrics,
      metricSources,
      ratios,
    };
  } catch (error) {
    return {
      processorName,
      status: "failed",
      error:
        error instanceof Error ? error.message : "Document AI processing failed.",
      revenueFromOperation: null,
      costOfMaterialConsumed: null,
      entities: [],
      yearAmountPairs: {},
      metrics: {},
      metricSources: {},
      ratios: null,
    };
  }
}

async function extractWithDocumentAIBatch(params: {
  documents: Array<{ gcsUri: string; mimeType: string }>;
  outputGcsUri: string;
}): Promise<Record<string, ExtractionResult>> {
  const projectId = process.env.DOC_AI_PROJECT_ID;
  const location = process.env.DOC_AI_LOCATION ?? "us";
  const processorId = process.env.DOC_AI_PROCESSOR_ID;
  const processorName =
    projectId && processorId
      ? `projects/${projectId}/locations/${location}/processors/${processorId}`
      : null;

  const results: Record<string, ExtractionResult> = {};
  for (const document of params.documents) {
    if (document.mimeType !== "application/pdf") {
      results[document.gcsUri] = {
        processorName,
        status: "skipped",
        error: "Document AI extraction is currently enabled only for PDF.",
        revenueFromOperation: null,
        costOfMaterialConsumed: null,
        entities: [],
        yearAmountPairs: {},
        metrics: {},
        metricSources: {},
        ratios: null,
      };
    }
  }

  const pdfDocuments = params.documents.filter(
    (document) => document.mimeType === "application/pdf",
  );
  if (pdfDocuments.length === 0) return results;

  if (!projectId || !processorId || !processorName) {
    for (const document of pdfDocuments) {
      results[document.gcsUri] = {
        processorName: null,
        status: "skipped",
        error: "Document AI processor is not configured.",
        revenueFromOperation: null,
        costOfMaterialConsumed: null,
        entities: [],
        yearAmountPairs: {},
        metrics: {},
        metricSources: {},
        ratios: null,
      };
    }
    return results;
  }

  try {
    const client = createDocumentAiClient();
    const request = {
      name: processorName,
      inputDocuments: {
        gcsDocuments: {
          documents: pdfDocuments.map((document) => ({
            gcsUri: document.gcsUri,
            mimeType: document.mimeType,
          })),
        },
      },
      documentOutputConfig: {
        gcsOutputConfig: {
          gcsUri: params.outputGcsUri,
        },
      },
    };
    const [operation] = await client.batchProcessDocuments(request);
    const [, metadata] = await operation.promise();
    const storage = createStorageClient();

    const statuses = metadata?.individualProcessStatuses ?? [];
    for (const status of statuses) {
      const inputGcsSource = String(status.inputGcsSource ?? "");
      if (!inputGcsSource) continue;

      if (status.status?.code && Number(status.status.code) !== 0) {
        results[inputGcsSource] = {
          processorName,
          status: "failed",
          error: status.status.message || "Document AI batch processing failed.",
          revenueFromOperation: null,
          costOfMaterialConsumed: null,
          entities: [],
          yearAmountPairs: {},
          metrics: {},
          metricSources: {},
          ratios: null,
        };
        continue;
      }

      const outputGcsDestination = String(status.outputGcsDestination ?? "");
      const outputPath = parseGcsUri(outputGcsDestination);
      if (!outputPath) {
        results[inputGcsSource] = {
          processorName,
          status: "failed",
          error: "Invalid batch output location returned by Document AI.",
          revenueFromOperation: null,
          costOfMaterialConsumed: null,
          entities: [],
          yearAmountPairs: {},
          metrics: {},
          metricSources: {},
          ratios: null,
        };
        continue;
      }

      const [outputFiles] = await storage
        .bucket(outputPath.bucket)
        .getFiles({ prefix: outputPath.objectName });
      const jsonFile = outputFiles.find((file) => file.name.endsWith(".json"));
      if (!jsonFile) {
        results[inputGcsSource] = {
          processorName,
          status: "failed",
          error: "Batch output JSON not found.",
          revenueFromOperation: null,
          costOfMaterialConsumed: null,
          entities: [],
          yearAmountPairs: {},
          metrics: {},
          metricSources: {},
          ratios: null,
        };
        continue;
      }

      const [fileBuffer] = await jsonFile.download();
      const parsed = JSON.parse(fileBuffer.toString("utf8")) as {
        document?: {
          text?: string | null;
          entities?: Array<{
            type?: string | null;
            mentionText?: string | null;
            confidence?: number | null;
            properties?: Array<{
              type?: string | null;
              mentionText?: string | null;
              confidence?: number | null;
            }> | null;
          }>;
        };
      };
      const rawEntities = parsed.document?.entities ?? [];
      const yearAmountPairs = buildYearAmountPairs(rawEntities);
      const docAiEntitiesDetailed = mapDocumentAiEntitiesToDetails(rawEntities);
      const documentTextLength =
        typeof parsed.document?.text === "string" ? parsed.document.text.length : null;
      const entities = rawEntities.map((entity) => ({
        type: String(entity.type ?? ""),
        mentionText: String(entity.mentionText ?? ""),
      }));
      const extracted = extractFinancialMetricsFromEntities(entities);
      const metrics = extracted.metrics;
      const metricSources = extracted.metricSources;
      const ratios = computeFinancialRatios(metrics, metricSources);
      results[inputGcsSource] = {
        processorName,
        status: "completed",
        error: null,
        revenueFromOperation:
          metrics.revenue_from_operation ?? metrics.revenue_from_operations ?? null,
        costOfMaterialConsumed:
          metrics.cost_of_material_consumed ??
          metrics.cost_of_materials_consumed ??
          null,
        docAiEntitiesDetailed,
        documentTextLength,
        entities,
        yearAmountPairs,
        metrics,
        metricSources,
        ratios,
      };
    }
  } catch (error) {
    for (const document of pdfDocuments) {
      if (results[document.gcsUri]) continue;
      results[document.gcsUri] = {
        processorName,
        status: "failed",
        error:
          error instanceof Error ? error.message : "Document AI batch processing failed.",
        revenueFromOperation: null,
        costOfMaterialConsumed: null,
        entities: [],
        yearAmountPairs: {},
        metrics: {},
        metricSources: {},
        ratios: null,
      };
    }
  }

  return results;
}

export async function uploadStatement(params: {
  file: File;
  year: string;
  userEmail: string;
  userId: string;
  companyId: string;
}) {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("Missing GCS bucket configuration.");
  }

  if (!validYears.has(params.year)) {
    throw new Error("Invalid year ending selected.");
  }

  const ext = getExtension(params.file.name);
  const validType =
    allowedMimeTypes.has(params.file.type) || allowedExtensions.has(ext);
  if (!validType) {
    throw new Error("Only PDF, Excel, or DOCX files are allowed.");
  }

  const fileBuffer = Buffer.from(await params.file.arrayBuffer());
  let processedFileBuffer = fileBuffer;
  let processedFileName = params.file.name;
  let processedMimeType = params.file.type || "application/octet-stream";
  const convertedFromDocx = isDocxUpload(params.file, ext);
  const convertedFromExcel = !convertedFromDocx && isExcelUpload(params.file, ext);

  if (convertedFromDocx || convertedFromExcel) {
    processedFileBuffer = await convertOfficeToPdfBuffer(fileBuffer, params.file.name);
    processedFileName = toPdfFileName(params.file.name);
    processedMimeType = pdfMimeType;
  }

  const storage = createStorageClient();
  const bucket = storage.bucket(bucketName);
  const uniqueId = crypto.randomUUID();
  const normalizedUserId = sanitizePathSegment(params.userId || "unknown-user");
  const companyId = params.companyId.trim();
  if (!isUuid(companyId)) {
    throw new Error("Invalid company.");
  }
  const companyPath = sanitizePathSegment(companyId);
  const objectName = `statements/${normalizedUserId}/${companyPath}/${params.year}/final-document-${Date.now()}-${uniqueId}-${sanitizeFileName(processedFileName)}`;
  const bucketFile = bucket.file(objectName);

  await saveFileToGcsWithRetry({
    bucketFile,
    fileBuffer: processedFileBuffer,
    fileType: processedMimeType,
    metadata: {
      yearEnding: params.year,
      companyId,
      uploadedBy: params.userEmail,
      uploadedByUserId: normalizedUserId,
      originalFileName: params.file.name,
    },
  });

  const normalizedEmail = params.userEmail.trim().toLowerCase() || "unknown-user";
  const gcsUri = `gs://${bucketName}/${objectName}`;
  const extraction = await extractWithDocumentAI(
    processedFileBuffer,
    processedMimeType,
  );
  const selectedAndRemainingByYear = buildSelectedAndRemainingByYear(
    extraction.yearAmountPairs,
    params.year,
  );
  const selectedYearData = buildMetricsForSelectedYear(
    extraction.yearAmountPairs,
    params.year,
  );
  const hasSelectedYearMetrics = Object.keys(selectedYearData.metrics).length > 0;
  const selectedYearRatios = hasSelectedYearMetrics
    ? computeFinancialRatios(selectedYearData.metrics, selectedYearData.metricSources)
    : null;
  const selectedYearRatioCategories = pickStoredFinancialRatioCategories(selectedYearRatios);
  const extractedRatioCategories = pickStoredFinancialRatioCategories(extraction.ratios);
  const selectedYearRevenueFromOperation =
    selectedYearData.metrics.revenue_from_operation ??
    selectedYearData.metrics.revenue_from_operations ??
    null;
  const selectedYearCostOfMaterialConsumed =
    selectedYearData.metrics.cost_of_material_consumed ??
    selectedYearData.metrics.cost_of_materials_consumed ??
    null;
  const resolvedRevenueFromOperation =
    selectedYearRevenueFromOperation ?? extraction.revenueFromOperation;
  const resolvedCostOfMaterialConsumed =
    selectedYearCostOfMaterialConsumed ?? extraction.costOfMaterialConsumed;
  const dbUserId = isUuid(params.userId) ? params.userId : null;
  const resolvedFinancialRatioCategories =
    selectedYearRatioCategories ?? extractedRatioCategories;
  const analysisResults = {
    status: extraction.status,
    processorName: extraction.processorName,
    revenueFromOperation: resolvedRevenueFromOperation,
    costOfMaterialConsumed: resolvedCostOfMaterialConsumed,
    yearAmountPairs: extraction.yearAmountPairs,
    selectedAndRemainingByYear,
    selectedYearMetrics: selectedYearData.metrics,
    selectedYearMetricSources: selectedYearData.metricSources,
    duplicateMetricWarnings: selectedYearData.duplicateMetricWarnings,
    selectedYearRatios: selectedYearRatioCategories,
    extractedMetrics: extraction.metrics,
    metricSources: extraction.metricSources,
    financialRatios: resolvedFinancialRatioCategories,
    extractedFinancialRatios: extractedRatioCategories,
    entities: extraction.entities,
    error: extraction.error,
    convertedFromDocx,
    convertedFromExcel,
    storedContentType: processedMimeType,
  };

  const documentType = "financial_statement";
  const allFieldRows = Object.entries(extraction.yearAmountPairs).flatMap(
    ([rawFieldKey, pairs]) => {
      const fieldKey = normalizeMetricKey(rawFieldKey);
      if (!fieldKey) return [];

      return pairs
        .filter((pair) => pair.amount !== null)
        .map((pair) => ({
          fieldKey,
          fieldYear: pair.year,
          fieldValue: pair.amount as number,
        }));
    },
  );

  try {
    await pool.query("BEGIN");
    const insertDocument = await pool.query(
      `INSERT INTO documents (
        user_id,
        user_email,
        company_id,
        year_ending,
        document_type,
        original_file_name,
        content_type,
        file_size_bytes,
        bucket_name,
        object_name,
        file_path,
        gcs_uri,
        status,
        processor_name,
        extraction_error,
        processed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
      RETURNING id`,
      [
        dbUserId,
        normalizedEmail,
        companyId,
        params.year,
        documentType,
        params.file.name,
        processedMimeType,
        processedFileBuffer.byteLength,
        bucketName,
        objectName,
        objectName,
        gcsUri,
        extraction.status,
        extraction.processorName,
        extraction.error,
      ],
    );
    const documentId = String(insertDocument.rows[0]?.id ?? "");

    if (!documentId) {
      throw new Error("Failed to create document record.");
    }

    for (const field of allFieldRows) {
      await pool.query(
        `INSERT INTO document_fields (
          document_id,
          field_key,
          field_year,
          field_value_text,
          field_value
        )
        VALUES ($1, $2, $3, $4, $5)`,
        [
          documentId,
          field.fieldKey,
          field.fieldYear,
          field.fieldValue.toString(),
          field.fieldValue,
        ],
      );
    }

    await pool.query(
      `INSERT INTO document_processing_logs (
        document_id,
        stage,
        status,
        message,
        payload_json
      )
      VALUES ($1, $2, $3, $4, $5)`,
      [
        documentId,
        "docai_extract",
        extraction.status,
        extraction.error ?? "Document extraction completed.",
        JSON.stringify(
          buildDocumentProcessingLogPayload({
            extraction,
            selectedYearData,
            selectedAndRemainingByYear,
            uploadYear: params.year,
          }),
        ),
      ],
    );

    await upsertFormulaResultsForDocument(
      documentId,
      resolvedFinancialRatioCategories,
    );

    await pool.query("COMMIT");
  } catch (dbError) {
    await pool.query("ROLLBACK");
    try {
      await bucketFile.delete({ ignoreNotFound: true });
    } catch (deleteError) {
      console.error("Failed to rollback uploaded file:", deleteError);
    }
    throw dbError;
  }

  return {
    objectName,
    bucket: bucketName,
    fileName: params.file.name,
    storedFileName: processedFileName,
    yearEnding: params.year,
    gcsUri,
    extraction: analysisResults,
  };
}

export async function uploadStatementsBatch(params: {
  statements: Array<{ file: File; year: string }>;
  userEmail: string;
  userId: string;
  companyId: string;
}) {
  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("Missing GCS bucket configuration.");
  }
  if (params.statements.length === 0) {
    throw new Error("Please attach at least one file.");
  }

  const storage = createStorageClient();
  const bucket = storage.bucket(bucketName);
  const normalizedEmail = params.userEmail.trim().toLowerCase() || "unknown-user";
  const normalizedUserId = sanitizePathSegment(params.userId || "unknown-user");
  const dbUserId = isUuid(params.userId) ? params.userId : null;
  const companyId = params.companyId.trim();
  if (!isUuid(companyId)) {
    throw new Error("Invalid company.");
  }
  const companyPath = sanitizePathSegment(companyId);

  const uploadedEntries: Array<{
    fileName: string;
    storedFileName: string;
    yearEnding: string;
    gcsUri: string;
    objectName: string;
    processedMimeType: string;
    processedFileBuffer: Buffer;
    convertedFromDocx: boolean;
    convertedFromExcel: boolean;
  }> = [];

  for (const statement of params.statements) {
    if (!validYears.has(statement.year)) {
      throw new Error("Invalid year ending selected.");
    }
    const ext = getExtension(statement.file.name);
    const validType =
      allowedMimeTypes.has(statement.file.type) || allowedExtensions.has(ext);
    if (!validType) {
      throw new Error("Only PDF, Excel, or DOCX files are allowed.");
    }

    const fileBuffer = Buffer.from(await statement.file.arrayBuffer());
    let processedFileBuffer = fileBuffer;
    let processedFileName = statement.file.name;
    let processedMimeType = statement.file.type || "application/octet-stream";
    const convertedFromDocx = isDocxUpload(statement.file, ext);
    const convertedFromExcel = !convertedFromDocx && isExcelUpload(statement.file, ext);

    if (convertedFromDocx || convertedFromExcel) {
      processedFileBuffer = await convertOfficeToPdfBuffer(fileBuffer, statement.file.name);
      processedFileName = toPdfFileName(statement.file.name);
      processedMimeType = pdfMimeType;
    }

    const uniqueId = crypto.randomUUID();
    const objectName = `statements/${normalizedUserId}/${companyPath}/${statement.year}/final-document-${Date.now()}-${uniqueId}-${sanitizeFileName(processedFileName)}`;
    const bucketFile = bucket.file(objectName);
    await saveFileToGcsWithRetry({
      bucketFile,
      fileBuffer: processedFileBuffer,
      fileType: processedMimeType,
      metadata: {
        yearEnding: statement.year,
        companyId,
        uploadedBy: params.userEmail,
        uploadedByUserId: normalizedUserId,
        originalFileName: statement.file.name,
      },
    });

    uploadedEntries.push({
      fileName: statement.file.name,
      storedFileName: processedFileName,
      yearEnding: statement.year,
      gcsUri: `gs://${bucketName}/${objectName}`,
      objectName,
      processedMimeType,
      processedFileBuffer,
      convertedFromDocx,
      convertedFromExcel,
    });
  }

  const extractionByUri: Record<string, ExtractionResult> = {};
  if (uploadedEntries.length === 1) {
    // Fast-path: avoid batch job overhead for a single file upload.
    const [entry] = uploadedEntries;
    extractionByUri[entry.gcsUri] = await extractWithDocumentAI(
      entry.processedFileBuffer,
      entry.processedMimeType,
    );
  } else {
    const batchOutputPrefix = `docai-output/${normalizedUserId}/${Date.now()}-${crypto.randomUUID()}/`;
    const batchResults = await extractWithDocumentAIBatch({
      documents: uploadedEntries.map((entry) => ({
        gcsUri: entry.gcsUri,
        mimeType: entry.processedMimeType,
      })),
      outputGcsUri: `gs://${bucketName}/${batchOutputPrefix}`,
    });
    Object.assign(extractionByUri, batchResults);
  }

  const uploads: Array<{
    objectName: string;
    bucket: string;
    fileName: string;
    storedFileName: string;
    yearEnding: string;
    gcsUri: string;
    extraction: Record<string, unknown>;
  }> = [];

  for (const entry of uploadedEntries) {
    const batchExtraction =
      extractionByUri[entry.gcsUri] ??
      ({
        processorName: null,
        status: "failed",
        error: "No extraction output found for document.",
        revenueFromOperation: null,
        costOfMaterialConsumed: null,
        entities: [],
        yearAmountPairs: {},
        metrics: {},
        metricSources: {},
        ratios: null,
      } satisfies ExtractionResult);
    let extraction = batchExtraction;

    // Fallback to single-document processing when batch output is missing/failed.
    if (
      entry.processedMimeType === pdfMimeType &&
      (batchExtraction.status !== "completed" ||
        Object.keys(batchExtraction.yearAmountPairs).length === 0)
    ) {
      const fallbackExtraction = await extractWithDocumentAI(
        entry.processedFileBuffer,
        entry.processedMimeType,
      );
      if (
        fallbackExtraction.status === "completed" &&
        Object.keys(fallbackExtraction.yearAmountPairs).length > 0
      ) {
        extraction = fallbackExtraction;
      } else {
        extraction = {
          ...batchExtraction,
          error:
            batchExtraction.error ??
            fallbackExtraction.error ??
            "Batch extraction did not return usable year data.",
        };
      }
    }

    const selectedAndRemainingByYear = buildSelectedAndRemainingByYear(
      extraction.yearAmountPairs,
      entry.yearEnding,
    );
    const selectedYearData = buildMetricsForSelectedYear(
      extraction.yearAmountPairs,
      entry.yearEnding,
    );
    const hasSelectedYearMetrics = Object.keys(selectedYearData.metrics).length > 0;
    const selectedYearRatios = hasSelectedYearMetrics
      ? computeFinancialRatios(selectedYearData.metrics, selectedYearData.metricSources)
      : null;
    const selectedYearRatioCategories = pickStoredFinancialRatioCategories(selectedYearRatios);
    const extractedRatioCategories = pickStoredFinancialRatioCategories(extraction.ratios);
    const selectedYearRevenueFromOperation =
      selectedYearData.metrics.revenue_from_operation ??
      selectedYearData.metrics.revenue_from_operations ??
      null;
    const selectedYearCostOfMaterialConsumed =
      selectedYearData.metrics.cost_of_material_consumed ??
      selectedYearData.metrics.cost_of_materials_consumed ??
      null;
    const resolvedRevenueFromOperation =
      selectedYearRevenueFromOperation ?? extraction.revenueFromOperation;
    const resolvedCostOfMaterialConsumed =
      selectedYearCostOfMaterialConsumed ?? extraction.costOfMaterialConsumed;
    const resolvedFinancialRatioCategories =
      selectedYearRatioCategories ?? extractedRatioCategories;
    const analysisResults = {
      status: extraction.status,
      processorName: extraction.processorName,
      revenueFromOperation: resolvedRevenueFromOperation,
      costOfMaterialConsumed: resolvedCostOfMaterialConsumed,
      yearAmountPairs: extraction.yearAmountPairs,
      selectedAndRemainingByYear,
      selectedYearMetrics: selectedYearData.metrics,
      selectedYearMetricSources: selectedYearData.metricSources,
      duplicateMetricWarnings: selectedYearData.duplicateMetricWarnings,
      selectedYearRatios: selectedYearRatioCategories,
      extractedMetrics: extraction.metrics,
      metricSources: extraction.metricSources,
      financialRatios: resolvedFinancialRatioCategories,
      extractedFinancialRatios: extractedRatioCategories,
      entities: extraction.entities,
      error: extraction.error,
      convertedFromDocx: entry.convertedFromDocx,
      convertedFromExcel: entry.convertedFromExcel,
      storedContentType: entry.processedMimeType,
    };

    const allFieldRows = Object.entries(extraction.yearAmountPairs).flatMap(
      ([rawFieldKey, pairs]) => {
        const fieldKey = normalizeMetricKey(rawFieldKey);
        if (!fieldKey) return [];
        return pairs
          .filter((pair) => pair.amount !== null)
          .map((pair) => ({
            fieldKey,
            fieldYear: pair.year,
            fieldValue: pair.amount as number,
          }));
      },
    );

    try {
      await pool.query("BEGIN");
      const insertDocument = await pool.query(
        `INSERT INTO documents (
          user_id,
          user_email,
          company_id,
          year_ending,
          document_type,
          original_file_name,
          content_type,
          file_size_bytes,
          bucket_name,
          object_name,
          file_path,
          gcs_uri,
          status,
          processor_name,
          extraction_error,
          processed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
        RETURNING id`,
        [
          dbUserId,
          normalizedEmail,
          companyId,
          entry.yearEnding,
          "financial_statement",
          entry.fileName,
          entry.processedMimeType,
          entry.processedFileBuffer.byteLength,
          bucketName,
          entry.objectName,
          entry.objectName,
          entry.gcsUri,
          extraction.status,
          extraction.processorName,
          extraction.error,
        ],
      );
      const documentId = String(insertDocument.rows[0]?.id ?? "");
      if (!documentId) throw new Error("Failed to create document record.");

      for (const field of allFieldRows) {
        await pool.query(
          `INSERT INTO document_fields (
            document_id,
            field_key,
            field_year,
            field_value_text,
            field_value
          )
          VALUES ($1, $2, $3, $4, $5)`,
          [
            documentId,
            field.fieldKey,
            field.fieldYear,
            field.fieldValue.toString(),
            field.fieldValue,
          ],
        );
      }

      await pool.query(
        `INSERT INTO document_processing_logs (
          document_id,
          stage,
          status,
          message,
          payload_json
        )
        VALUES ($1, $2, $3, $4, $5)`,
        [
          documentId,
          "docai_extract",
          extraction.status,
          extraction.error ?? "Document extraction completed.",
          JSON.stringify(
            buildDocumentProcessingLogPayload({
              extraction,
              selectedYearData,
              selectedAndRemainingByYear,
              uploadYear: entry.yearEnding,
            }),
          ),
        ],
      );

      await upsertFormulaResultsForDocument(
        documentId,
        resolvedFinancialRatioCategories,
      );
      await pool.query("COMMIT");
    } catch (dbError) {
      await pool.query("ROLLBACK");
      throw dbError;
    }

    uploads.push({
      objectName: entry.objectName,
      bucket: bucketName,
      fileName: entry.fileName,
      storedFileName: entry.storedFileName,
      yearEnding: entry.yearEnding,
      gcsUri: entry.gcsUri,
      extraction: analysisResults,
    });
  }

  return { uploads };
}

export async function listStatementHistory(params: {
  userId: string;
  companyId: string;
  year?: string;
  limit?: number;
}): Promise<StatementHistoryItem[]> {
  if (!isUuid(params.userId) || !isUuid(params.companyId)) {
    return [];
  }

  const safeLimit = Math.min(Math.max(params.limit ?? 25, 1), 100);

  const yearFilter = params.year && validYears.has(params.year) ? params.year : null;

  const { rows: documentRows } = yearFilter
    ? await pool.query(
        `SELECT
          d.id,
          d.user_id,
          d.company_id,
          c.name AS company_name,
          d.year_ending,
          COALESCE(d.file_path, d.object_name) AS file_path,
          d.gcs_uri,
          d.original_file_name,
          d.status,
          d.uploaded_at
        FROM documents d
        INNER JOIN companies c ON c.id = d.company_id
        WHERE d.user_id = $1
          AND d.company_id = $2
          AND d.year_ending = $3
        ORDER BY d.uploaded_at DESC
        LIMIT 1`,
        [params.userId, params.companyId, yearFilter],
      )
    : await pool.query(
        `SELECT * FROM (
          SELECT DISTINCT ON (d.year_ending)
            d.id,
            d.user_id,
            d.company_id,
            c.name AS company_name,
            d.year_ending,
            COALESCE(d.file_path, d.object_name) AS file_path,
            d.gcs_uri,
            d.original_file_name,
            d.status,
            d.uploaded_at
          FROM documents d
          INNER JOIN companies c ON c.id = d.company_id
          WHERE d.user_id = $1 AND d.company_id = $2
          ORDER BY d.year_ending, d.uploaded_at DESC
        ) sub
        ORDER BY sub.year_ending DESC
        LIMIT $3`,
        [params.userId, params.companyId, safeLimit],
      );

  if (documentRows.length === 0) return [];

  const documentIds = documentRows.map((row) => String(row.id));
  const { rows: fieldRows } = await pool.query(
    `SELECT
      d.id AS document_id,
      d.year_ending,
      df.field_key,
      df.field_year,
      df.field_value
    FROM documents d
    INNER JOIN document_fields df
      ON df.document_id = d.id
    WHERE d.id = ANY($1::uuid[])`,
    [documentIds],
  );

  const metricsByDocumentYear = new Map<string, Record<string, number>>();
  const metricSourcesByDocumentYear = new Map<
    string,
    Record<string, "document" | "alias" | "derived">
  >();
  for (const row of fieldRows) {
    const documentId = String(row.document_id);
    const yearEnding = String(row.year_ending ?? "");
    const fieldYear = row.field_year ? String(row.field_year) : yearEnding;
    if (!fieldYear) continue;
    const fieldKey = String(row.field_key);
    const value = toNumber(row.field_value);
    if (value === null) continue;
    const bucketKey = `${documentId}:${fieldYear}`;
    const existingMetrics = metricsByDocumentYear.get(bucketKey) ?? {};
    existingMetrics[fieldKey] = value;
    metricsByDocumentYear.set(bucketKey, existingMetrics);
    const existingSources = metricSourcesByDocumentYear.get(bucketKey) ?? {};
    existingSources[fieldKey] = "document";
    metricSourcesByDocumentYear.set(bucketKey, existingSources);
  }

  const { rows: ratioRows } = await pool.query(
    `SELECT
      fr.document_id,
      f.formula_name,
      f.formula_expression,
      fr.result_value,
      fr.details
    FROM formula_results fr
    INNER JOIN formulas f
      ON f.id = fr.formula_id
    WHERE fr.document_id = ANY($1::uuid[])
      AND f.formula_name = ANY($2::text[])`,
    [
      documentIds,
      [
        ...profitabilityFormulaNames,
        ...liquidityFormulaNames,
        ...leverageSolvencyFormulaNames,
        ...cashFlowFormulaNames,
        ...dupontFormulaNames,
        ...leverageAnalysisFormulaNames,
        ...otherImportantFormulaNames,
        ...activityEfficiencyFormulaNames,
      ],
    ],
  );

  const { rows: logRows } = await pool.query(
    `SELECT document_id, payload_json, created_at
     FROM document_processing_logs
     WHERE document_id = ANY($1::uuid[])
       AND stage = 'docai_extract'
     ORDER BY created_at DESC`,
    [documentIds],
  );

  const warningsByDocumentId = new Map<string, unknown[]>();
  for (const row of logRows) {
    const documentId = String(row.document_id);
    if (warningsByDocumentId.has(documentId)) continue;
    const payload =
      row.payload_json && typeof row.payload_json === "object"
        ? (row.payload_json as Record<string, unknown>)
        : null;
    const warnings = Array.isArray(payload?.duplicateMetricWarnings)
      ? payload.duplicateMetricWarnings
      : [];
    warningsByDocumentId.set(documentId, warnings);
  }

  const profitabilityNameSet = new Set<string>(profitabilityFormulaNames);
  const liquidityNameSet = new Set<string>(liquidityFormulaNames);
  const leverageNameSet = new Set<string>(leverageSolvencyFormulaNames);
  const cashFlowNameSet = new Set<string>(cashFlowFormulaNames);
  const dupontNameSet = new Set<string>(dupontFormulaNames);
  const leverageAnalysisNameSet = new Set<string>(leverageAnalysisFormulaNames);
  const otherImportantNameSet = new Set<string>(otherImportantFormulaNames);
  const activityEfficiencyNameSet = new Set<string>(activityEfficiencyFormulaNames);
  const profitabilityByDocument = new Map<string, Record<string, unknown>>();
  const liquidityByDocument = new Map<string, Record<string, unknown>>();
  const leverageByDocument = new Map<string, Record<string, unknown>>();
  const cashFlowByDocument = new Map<string, Record<string, unknown>>();
  const dupontByDocument = new Map<string, Record<string, unknown>>();
  const leverageAnalysisByDocument = new Map<string, Record<string, unknown>>();
  const otherImportantByDocument = new Map<string, Record<string, unknown>>();
  const activityEfficiencyByDocument = new Map<string, Record<string, unknown>>();
  for (const row of ratioRows) {
    const documentId = String(row.document_id);
    const formulaName = String(row.formula_name);
    const details =
      row.details && typeof row.details === "object"
        ? (row.details as Record<string, unknown>)
        : {};

    const entry = {
      value: toNumber(row.result_value),
      formula:
        typeof details.formula === "string"
          ? details.formula
          : String(row.formula_expression ?? ""),
      missingFields: Array.isArray(details.missingFields)
        ? details.missingFields
        : [],
      notes: Array.isArray(details.notes) ? details.notes : [],
      source:
        details.source === "document" ||
        details.source === "derived" ||
        details.source === "mixed" ||
        details.source === "unknown"
          ? details.source
          : "unknown",
    };

    if (profitabilityNameSet.has(formulaName)) {
      const existing = profitabilityByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      profitabilityByDocument.set(documentId, existing);
    } else if (liquidityNameSet.has(formulaName)) {
      const existing = liquidityByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      liquidityByDocument.set(documentId, existing);
    } else if (leverageNameSet.has(formulaName)) {
      const existing = leverageByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      leverageByDocument.set(documentId, existing);
    } else if (cashFlowNameSet.has(formulaName)) {
      const existing = cashFlowByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      cashFlowByDocument.set(documentId, existing);
    } else if (dupontNameSet.has(formulaName)) {
      const existing = dupontByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      dupontByDocument.set(documentId, existing);
    } else if (leverageAnalysisNameSet.has(formulaName)) {
      const existing = leverageAnalysisByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      leverageAnalysisByDocument.set(documentId, existing);
    } else if (otherImportantNameSet.has(formulaName)) {
      const existing = otherImportantByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      otherImportantByDocument.set(documentId, existing);
    } else if (activityEfficiencyNameSet.has(formulaName)) {
      const existing = activityEfficiencyByDocument.get(documentId) ?? {};
      existing[formulaName] = entry;
      activityEfficiencyByDocument.set(documentId, existing);
    }
  }

  return documentRows.map((row) => {
    const documentId = String(row.id);
    const yearEntries = Array.from(metricsByDocumentYear.entries()).filter(([key]) =>
      key.startsWith(`${documentId}:`),
    );
    const yearlyData: Record<
      string,
      {
        revenueFromOperation: number | null;
        costOfMaterialConsumed: number | null;
        financialRatios: {
          profitabilityRatios: Record<string, unknown>;
          liquidityRatios: Record<string, unknown>;
          leverageSolvencyRatios: Record<string, unknown>;
          cashFlowRatios: Record<string, unknown>;
          dupontAnalysis: Record<string, unknown>;
          leverageAnalysis: Record<string, unknown>;
          otherImportantRatios: Record<string, unknown>;
          activityEfficiencyRatios: Record<string, unknown>;
        } | null;
      }
    > = {};
    for (const [bucketKey, metrics] of yearEntries) {
      const year = bucketKey.split(":")[1] ?? "";
      if (!year) continue;
      const metricSources = metricSourcesByDocumentYear.get(bucketKey) ?? {};
      const enriched = enrichMetricsForRatioComputation(metrics, metricSources);
      const ratios = computeFinancialRatios(
        enriched.metrics,
        enriched.metricSources,
      );
      const revenue =
        metrics.revenue_from_operations ?? metrics.revenue_from_operation ?? null;
      const cost =
        metrics.cost_of_materials_consumed ?? metrics.cost_of_material_consumed ?? null;
      yearlyData[year] = {
        revenueFromOperation: revenue,
        costOfMaterialConsumed: cost,
        financialRatios: {
          profitabilityRatios: ratios.profitabilityRatios,
          liquidityRatios: ratios.liquidityRatios,
          leverageSolvencyRatios: ratios.leverageSolvencyRatios,
          cashFlowRatios: ratios.cashFlowRatios,
          dupontAnalysis: ratios.dupontAnalysis,
          leverageAnalysis: ratios.leverageAnalysis,
          otherImportantRatios: ratios.otherImportantRatios,
          activityEfficiencyRatios: ratios.activityEfficiencyRatios,
        },
      };
    }

    const years = toSortedYearsDesc(Object.keys(yearlyData));
    const primaryYear =
      years.includes(String(row.year_ending)) && String(row.year_ending)
        ? String(row.year_ending)
        : years[0] ?? "";
    const selectedYearData = yearlyData[primaryYear] ?? null;
    const revenue = selectedYearData?.revenueFromOperation ?? null;
    const cost = selectedYearData?.costOfMaterialConsumed ?? null;
    const profitabilityRatiosFromDb = profitabilityByDocument.get(documentId) ?? {};
    const liquidityRatiosFromDb = liquidityByDocument.get(documentId) ?? {};
    const leverageRatiosFromDb = leverageByDocument.get(documentId) ?? {};
    const cashFlowRatiosFromDb = cashFlowByDocument.get(documentId) ?? {};
    const dupontRatiosFromDb = dupontByDocument.get(documentId) ?? {};
    const leverageAnalysisRatiosFromDb = leverageAnalysisByDocument.get(documentId) ?? {};
    const otherImportantRatiosFromDb = otherImportantByDocument.get(documentId) ?? {};
    const activityEfficiencyRatiosFromDb = activityEfficiencyByDocument.get(documentId) ?? {};
    const computedFinancialRatios = selectedYearData?.financialRatios ?? null;
    const profitabilityRatios =
      Object.keys(profitabilityRatiosFromDb).length > 0
        ? profitabilityRatiosFromDb
        : computedFinancialRatios?.profitabilityRatios ?? {};
    const liquidityRatios =
      Object.keys(liquidityRatiosFromDb).length > 0
        ? liquidityRatiosFromDb
        : computedFinancialRatios?.liquidityRatios ?? {};
    const leverageSolvencyRatios =
      Object.keys(leverageRatiosFromDb).length > 0
        ? leverageRatiosFromDb
        : computedFinancialRatios?.leverageSolvencyRatios ?? {};
    const cashFlowRatios =
      Object.keys(cashFlowRatiosFromDb).length > 0
        ? cashFlowRatiosFromDb
        : computedFinancialRatios?.cashFlowRatios ?? {};
    const dupontAnalysis =
      Object.keys(dupontRatiosFromDb).length > 0
        ? dupontRatiosFromDb
        : computedFinancialRatios?.dupontAnalysis ?? {};
    const leverageAnalysis =
      Object.keys(leverageAnalysisRatiosFromDb).length > 0
        ? leverageAnalysisRatiosFromDb
        : computedFinancialRatios?.leverageAnalysis ?? {};
    const otherImportantRatios =
      Object.keys(otherImportantRatiosFromDb).length > 0
        ? otherImportantRatiosFromDb
        : computedFinancialRatios?.otherImportantRatios ?? {};
    const activityEfficiencyRatios =
      Object.keys(activityEfficiencyRatiosFromDb).length > 0
        ? activityEfficiencyRatiosFromDb
        : computedFinancialRatios?.activityEfficiencyRatios ?? {};
    const hasFinancialRatios =
      Object.keys(profitabilityRatios).length > 0 ||
      Object.keys(liquidityRatios).length > 0 ||
      Object.keys(leverageSolvencyRatios).length > 0 ||
      Object.keys(cashFlowRatios).length > 0 ||
      Object.keys(dupontAnalysis).length > 0 ||
      Object.keys(leverageAnalysis).length > 0 ||
      Object.keys(otherImportantRatios).length > 0 ||
      Object.keys(activityEfficiencyRatios).length > 0;
    const duplicateMetricWarnings = warningsByDocumentId.get(documentId) ?? [];
    const analysisResults: Record<string, unknown> = {
      revenueFromOperation: revenue,
      costOfMaterialConsumed: cost,
      duplicateMetricWarnings,
      yearlyData,
      financialRatios: hasFinancialRatios
        ? {
            profitabilityRatios,
            liquidityRatios,
            leverageSolvencyRatios,
            cashFlowRatios,
            dupontAnalysis,
            leverageAnalysis,
            otherImportantRatios,
            activityEfficiencyRatios,
          }
        : null,
    };

    return {
      id: documentId,
      userId: row.user_id ? String(row.user_id) : null,
      companyId: String(row.company_id ?? ""),
      companyName: String(row.company_name ?? ""),
      yearEnding: String(row.year_ending),
      filePath: String(row.file_path ?? ""),
      gcsUri: String(row.gcs_uri ?? ""),
      originalFileName: String(row.original_file_name ?? ""),
      extractionStatus: String(row.status ?? ""),
      analysisResults,
      createdAt: new Date(row.uploaded_at).toISOString(),
    };
  });
}

export function classifyUploadError(error: unknown) {
  const message = error instanceof Error ? error.message : "Upload failed.";
  if (message === "Missing GCS bucket configuration.") {
    return { status: 500, error: message };
  }
  if (
    message === "Invalid year ending selected." ||
    message === "Only PDF, Excel, or DOCX files are allowed." ||
    message === "Invalid company."
  ) {
    return { status: 400, error: message };
  }
  if (message.startsWith("Office to PDF conversion failed:")) {
    return { status: 500, error: message };
  }
  if (isRetryableStorageError(error)) {
    return {
      status: 500,
      error: "Network issue while uploading to storage. Please retry once.",
    };
  }
  return {
    status: 500,
    error: "Failed to upload statement to storage.",
  };
}
