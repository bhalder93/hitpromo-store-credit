import {
  useLoaderData,
  useFetcher,
  useNavigate,
  useLocation,
  useNavigation,
  useRouteError,
  isRouteErrorResponse,
} from "react-router";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

/* ==========================================================================
   CONSTANTS
   ========================================================================== */

const CUSTOMER_PAGE_SIZE = 50;
const CUSTOMER_EXPORT_PAGE_SIZE = 250;
const TRANSACTION_PAGE_SIZE = 250;

const DEFAULT_CURRENCY = "USD";

const CUSTOMER_QUERY = `#graphql
  query Customers($cursor: String, $search: String) {
    shop {
      currencyCode
    }
    customers(
      first: ${CUSTOMER_PAGE_SIZE}
      after: $cursor
      query: $search
    ) {
      edges {
        node {
          id
          firstName
          lastName
          email
          createdAt

          storeCreditAccounts(first: 10) {
            nodes {
              id
              balance {
                amount
                currencyCode
              }

              transactions(first: ${TRANSACTION_PAGE_SIZE}) {
                nodes {
                  amount {
                    amount
                  }
                  event
                  createdAt
                  origin {
                    __typename
                  }
                  balanceAfterTransaction {
                    amount
                  }
                }
              }
            }
          }
        }
      }

      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const STORE_CREDIT_CREDIT_MUTATION = `#graphql
  mutation StoreCreditAccountCredit(
    $id: ID!
    $creditInput: StoreCreditAccountCreditInput!
  ) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        id
        amount {
          amount
          currencyCode
        }
        balanceAfterTransaction {
          amount
          currencyCode
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STORE_CREDIT_DEBIT_MUTATION = `#graphql
  mutation StoreCreditAccountDebit(
    $id: ID!
    $debitInput: StoreCreditAccountDebitInput!
  ) {
    storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
      storeCreditAccountTransaction {
        id
        amount {
          amount
          currencyCode
        }
        balanceAfterTransaction {
          amount
          currencyCode
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CUSTOMER_HISTORY_QUERY = `#graphql
  query CustomerHistory($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      email

      storeCreditAccounts(first: 10) {
        nodes {
          balance {
            currencyCode
          }

          transactions(first: ${TRANSACTION_PAGE_SIZE}) {
            nodes {
              amount {
                amount
              }
              event
              createdAt
              origin {
                __typename
              }
              balanceAfterTransaction {
                amount
              }
            }
          }
        }
      }
    }
  }
`;

const CUSTOMER_EXPORT_QUERY = `#graphql
  query CustomerExport($cursor: String) {
    customers(
      first: ${CUSTOMER_EXPORT_PAGE_SIZE}
      after: $cursor
    ) {
      nodes {
        id
        firstName
        lastName
        email

        storeCreditAccounts(first: 10) {
          nodes {
            balance {
              amount
              currencyCode
            }

            transactions(first: ${TRANSACTION_PAGE_SIZE}) {
              nodes {
                amount {
                  amount
                }
              }
            }
          }
        }
      }

      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/* ==========================================================================
   GENERAL HELPERS
   ========================================================================== */

function getErrorMessage(error) {
  if (!error) {
    return "An unexpected error occurred.";
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

function createJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function createErrorResponse(message, status = 500) {
  return createJsonResponse(
    {
      error: message,
    },
    status,
  );
}

/* ==========================================================================
   SHOPIFY GRAPHQL
   ========================================================================== */

async function executeGraphQL(admin, query, variables = {}) {
  let response;

  try {
    response = await admin.graphql(query, {
      variables,
    });
  } catch (error) {
    console.error("Shopify GraphQL request failed:", {
      message: error?.message,
      graphQLErrors: error?.graphQLErrors,
      responseErrors: error?.response?.body?.errors,
      responseStatus: error?.response?.status,
      variables,
    });

    throw new Error("Unable to connect to Shopify. Please try again.");
  }

  if (!response) {
    throw new Error("Shopify returned an empty response.");
  }

  if (!response.ok) {
    console.error("Shopify GraphQL HTTP error:", {
      status: response.status,
      statusText: response.statusText,
    });

    throw new Error("Shopify API request failed. Please try again.");
  }

  let json;

  try {
    json = await response.json();
  } catch (error) {
    console.error("Failed to parse Shopify GraphQL response:", error);

    throw new Error("Shopify returned an invalid response.");
  }

  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    console.error("Shopify GraphQL errors:", json.errors);

    const message =
      json.errors
        .map((error) => error?.message)
        .filter(Boolean)
        .join(", ") || "Shopify returned a GraphQL error.";

    throw new Error(message);
  }

  return json;
}

/* ==========================================================================
   CUSTOMER HELPERS
   ========================================================================== */

function getCustomerName(customer) {
  const name = [customer?.firstName, customer?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name || "No Name";
}

function getCustomerEmail(customer) {
  return customer?.email || "No Email";
}

function getCustomerId(customer) {
  if (!customer?.id) {
    return "";
  }

  return String(customer.id).split("/").pop();
}

function getAccounts(customer) {
  return Array.isArray(customer?.storeCreditAccounts?.nodes)
    ? customer.storeCreditAccounts.nodes
    : [];
}

/* ==========================================================================
   CREDIT CALCULATIONS
   ========================================================================== */

function parseAmount(value) {
  const amount = Number.parseFloat(value);

  return Number.isFinite(amount) ? amount : 0;
}

function calculateCustomerCredit(customer, defaultCurrency = DEFAULT_CURRENCY) {
  const accounts = getAccounts(customer);

  let totalIssued = 0;
  let totalRedeemed = 0;
  let currentBalance = 0;

  let currency = defaultCurrency;

  for (const account of accounts) {
    currency = account?.balance?.currencyCode || currency;

    currentBalance += parseAmount(account?.balance?.amount);

    const transactions = Array.isArray(account?.transactions?.nodes)
      ? account.transactions.nodes
      : [];

    for (const transaction of transactions) {
      const amount = parseAmount(transaction?.amount?.amount);

      if (amount > 0) {
        totalIssued += amount;
      } else if (amount < 0) {
        totalRedeemed += Math.abs(amount);
      }
    }
  }

  return {
    totalIssued,
    totalRedeemed,
    currentBalance,
    currency,
  };
}

/* ==========================================================================
   CSV HELPERS
   ========================================================================== */

function escapeCsv(value) {
  if (value === null || value === undefined) {
    return '""';
  }

  const stringValue = String(value);

  return `"${stringValue.replaceAll('"', '""')}"`;
}

function formatAmount(amount) {
  return parseAmount(amount).toFixed(2);
}

function formatDate(date) {
  if (!date) {
    return "";
  }

  const parsedDate = new Date(date);

  if (Number.isNaN(parsedDate.getTime())) {
    return "";
  }

  return parsedDate.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createCsv(headers, rows) {
  const csvRows = [
    headers.map(escapeCsv).join(","),
    ...rows.map((row) => row.map(escapeCsv).join(",")),
  ];

  /*
   * UTF-8 BOM improves Excel compatibility.
   */
  return `\uFEFF${csvRows.join("\r\n")}`;
}

function createDownloadResponse(csv, filename) {
  return new Response(csv, {
    status: 200,

    headers: {
      "Content-Type": "text/csv; charset=utf-8",

      "Content-Disposition": `attachment; filename="${filename}"`,

      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",

      Pragma: "no-cache",

      Expires: "0",
    },
  });
}

function createFilename(prefix) {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  return `${prefix}-${timestamp}.csv`;
}

/* ==========================================================================
   LOADER
   ========================================================================== */

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);

    const rawCursor = url.searchParams.get("cursor");

    const rawSearch = url.searchParams.get("search");

    const cursor = rawCursor?.trim() || null;

    const search = rawSearch?.trim() || null;

    const json = await executeGraphQL(admin, CUSTOMER_QUERY, {
      cursor,
      search,
    });

    const customers = json?.data?.customers;

    if (!customers) {
      console.error("Invalid customer response:", json);

      throw new Error("Customer data could not be loaded.");
    }

    const shopCurrency = json?.data?.shop?.currencyCode || DEFAULT_CURRENCY;

    return {
      edges: Array.isArray(customers.edges)
        ? customers.edges.filter((edge) => edge?.node?.id)
        : [],

      pageInfo: {
        hasNextPage: customers.pageInfo?.hasNextPage === true,

        endCursor: customers.pageInfo?.endCursor || null,
      },

      shopCurrency,

      error: null,
    };
  } catch (error) {
    console.error("Customer loader error:", error);

    /*
     * Authentication errors and unexpected errors
     * should reach the route ErrorBoundary.
     */
    throw new Response(
      "Unable to load customer data. Please refresh the page and try again.",
      {
        status: 500,
      },
    );
  }
};

/* ==========================================================================
   ACTION
   ========================================================================== */

export const action = async ({ request }) => {
  try {
    if (request.method.toUpperCase() !== "POST") {
      return createErrorResponse("Method not allowed.", 405);
    }

    const { admin } = await authenticate.admin(request);

    const formData = await request.formData();

    const actionType = formData.get("actionType");

    const customerId = formData.get("customerId");

    /* ----------------------------------------------------------------------
       CUSTOMER HISTORY
       ---------------------------------------------------------------------- */

    if (actionType === "history") {
      if (typeof customerId !== "string" || !customerId.trim()) {
        return createErrorResponse("A valid customer ID is required.", 400);
      }

      const json = await executeGraphQL(admin, CUSTOMER_HISTORY_QUERY, {
        id: customerId.trim(),
      });

      const customer = json?.data?.customer;

      if (!customer) {
        return createErrorResponse("Customer could not be found.", 404);
      }

      const accounts = getAccounts(customer);

      const rows = [];

      for (const account of accounts) {
        const currency = account?.balance?.currencyCode || DEFAULT_CURRENCY;

        const transactions = Array.isArray(account?.transactions?.nodes)
          ? account.transactions.nodes
          : [];

        for (const transaction of transactions) {
          rows.push([
            formatDate(transaction?.createdAt),

            transaction?.event || "Unknown",

            formatAmount(transaction?.amount?.amount),

            currency,

            formatAmount(transaction?.balanceAfterTransaction?.amount),

            transaction?.origin?.__typename || "Unknown",
          ]);
        }
      }

      /*
       * Newest transactions first.
       */
      rows.sort((a, b) => {
        return new Date(b[0]).getTime() - new Date(a[0]).getTime();
      });

      const csv = createCsv(
        ["Date", "Event", "Amount", "Currency", "Balance After", "Origin"],
        rows,
      );

      const customerName =
        getCustomerName(customer)
          .replace(/[^a-z0-9]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase() || "customer";

      return createDownloadResponse(
        csv,
        createFilename(`customer-history-${customerName}`),
      );
    }

    /* ----------------------------------------------------------------------
       GLOBAL BULK REPORT
       ---------------------------------------------------------------------- */

    if (actionType === "bulk") {
      const allCustomers = [];

      let cursor = null;

      let hasNextPage = true;

      /*
       * Fetch every customer page instead of only
       * the first 250 customers.
       */
      while (hasNextPage) {
        const json = await executeGraphQL(admin, CUSTOMER_EXPORT_QUERY, {
          cursor,
        });

        const customers = json?.data?.customers;

        if (!customers) {
          throw new Error("Unable to retrieve customer export data.");
        }

        const nodes = Array.isArray(customers.nodes) ? customers.nodes : [];

        allCustomers.push(...nodes);

        hasNextPage = customers.pageInfo?.hasNextPage === true;

        cursor = customers.pageInfo?.endCursor || null;

        /*
         * Safety check prevents an accidental
         * infinite pagination loop.
         */
        if (hasNextPage && !cursor) {
          throw new Error("Shopify returned an invalid pagination cursor.");
        }
      }

      const rows = allCustomers.map((customer) => {
        const credit = calculateCustomerCredit(customer);

        return [
          getCustomerId(customer),

          customer?.firstName || "",

          customer?.lastName || "",

          customer?.email || "",

          formatAmount(credit.totalIssued),

          formatAmount(credit.totalRedeemed),

          formatAmount(credit.currentBalance),

          credit.currency,
        ];
      });

      const csv = createCsv(
        [
          "Customer ID",
          "First Name",
          "Last Name",
          "Email",
          "Total Issued",
          "Total Redeemed",
          "Remaining Balance",
          "Currency",
        ],
        rows,
      );

      return createDownloadResponse(
        csv,
        createFilename("customer-store-credit-report"),
      );
    }

    /* ----------------------------------------------------------------------
       ADJUST STORE CREDIT (CREDIT OR DEBIT)
       ---------------------------------------------------------------------- */

    if (actionType === "adjustCredit") {
      if (typeof customerId !== "string" || !customerId.trim()) {
        return createErrorResponse("A valid customer ID is required.", 400);
      }

      const adjustType = formData.get("adjustType");

      if (adjustType !== "credit" && adjustType !== "debit") {
        return createErrorResponse(
          "Adjustment type must be either 'credit' or 'debit'.",
          400,
        );
      }

      const rawAmount = formData.get("amount");
      const parsedAmountValue = Number.parseFloat(rawAmount);

      if (!Number.isFinite(parsedAmountValue) || parsedAmountValue <= 0) {
        return createErrorResponse(
          "Amount must be a valid number greater than 0.",
          400,
        );
      }

      const formattedAmount = parsedAmountValue.toFixed(2);
      const rawCurrency = formData.get("currency");
      const currency = (
        typeof rawCurrency === "string" && rawCurrency.trim()
          ? rawCurrency.trim()
          : DEFAULT_CURRENCY
      ).toUpperCase();

      const note = formData.get("note");

      if (adjustType === "credit") {
        const expiresAt = formData.get("expiresAt");
        const notify = formData.get("notify") === "true";

        const creditInput = {
          creditAmount: {
            amount: formattedAmount,
            currencyCode: currency,
          },
          notify,
        };

        if (typeof expiresAt === "string" && expiresAt.trim()) {
          const expDate = new Date(expiresAt.trim());

          if (!Number.isNaN(expDate.getTime())) {
            expDate.setUTCHours(23, 59, 59, 999);
            creditInput.expiresAt = expDate.toISOString();
          }
        }

        if (typeof note === "string" && note.trim()) {
          creditInput.note = note.trim();
        }

        const json = await executeGraphQL(admin, STORE_CREDIT_CREDIT_MUTATION, {
          id: customerId.trim(),
          creditInput,
        });

        const userErrors =
          json?.data?.storeCreditAccountCredit?.userErrors || [];

        if (userErrors.length > 0) {
          const message =
            userErrors
              .map((error) => error?.message)
              .filter(Boolean)
              .join(", ") || "Unable to add store credit.";

          return createErrorResponse(message, 400);
        }

        const transaction =
          json?.data?.storeCreditAccountCredit?.storeCreditAccountTransaction;

        const balanceAfter = transaction?.balanceAfterTransaction?.amount;

        return createJsonResponse({
          success: true,
          message: `Successfully added ${formattedAmount} ${currency} store credit.${balanceAfter ? ` New balance: ${balanceAfter} ${currency}.` : ""
            }`,
          transaction,
        });
      }

      if (adjustType === "debit") {
        const debitInput = {
          debitAmount: {
            amount: formattedAmount,
            currencyCode: currency,
          },
        };

        if (typeof note === "string" && note.trim()) {
          debitInput.note = note.trim();
        }

        const json = await executeGraphQL(admin, STORE_CREDIT_DEBIT_MUTATION, {
          id: customerId.trim(),
          debitInput,
        });

        const userErrors =
          json?.data?.storeCreditAccountDebit?.userErrors || [];

        if (userErrors.length > 0) {
          const message =
            userErrors
              .map((error) => error?.message)
              .filter(Boolean)
              .join(", ") || "Unable to deduct store credit.";

          return createErrorResponse(message, 400);
        }

        const transaction =
          json?.data?.storeCreditAccountDebit?.storeCreditAccountTransaction;

        const balanceAfter = transaction?.balanceAfterTransaction?.amount;

        return createJsonResponse({
          success: true,
          message: `Successfully deducted ${formattedAmount} ${currency} store credit.${balanceAfter ? ` New balance: ${balanceAfter} ${currency}.` : ""
            }`,
          transaction,
        });
      }
    }

    return createErrorResponse("Invalid action type specified.", 400);
  } catch (error) {
    console.error("Customer action error:", error);

    return createErrorResponse(
      getErrorMessage(error) || "Unable to process the request.",
      500,
    );
  }
};

/* ==========================================================================
   PAGE
   ========================================================================== */

export default function CustomersPage() {
  const {
    edges = [],
    pageInfo = {
      hasNextPage: false,
      endCursor: null,
    },
    shopCurrency = DEFAULT_CURRENCY,
    error: loaderError,
  } = useLoaderData() || {};

  const fetcher = useFetcher();
  const creditFetcher = useFetcher();

  const navigate = useNavigate();

  const location = useLocation();

  const navigation = useNavigation();

  const shopify = useAppBridge();

  const tableRef = useRef(null);

  const downloadHandledRef = useRef(false);

  /* ------------------------------------------------------------------------
     MANAGE CREDIT FORM STATE
     ------------------------------------------------------------------------ */

  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [adjustType, setAdjustType] = useState("credit");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [notify, setNotify] = useState(true);

  const todayDate = useMemo(() => new Date().toISOString().split("T")[0], []);

  /* ------------------------------------------------------------------------
     SELECTED CUSTOMER CREDIT SUMMARY
     ------------------------------------------------------------------------ */

  const selectedCustomerCredit = useMemo(() => {
    if (!selectedCustomer) {
      return {
        totalIssued: 0,
        totalRedeemed: 0,
        currentBalance: 0,
        currency: shopCurrency || DEFAULT_CURRENCY,
      };
    }

    return calculateCustomerCredit(
      selectedCustomer,
      shopCurrency || DEFAULT_CURRENCY,
    );
  }, [selectedCustomer, shopCurrency]);

  /* ------------------------------------------------------------------------
     FETCHER STATE
     ------------------------------------------------------------------------ */

  const submittedAction = fetcher.formData?.get("actionType");

  const submittedCustomerId = fetcher.formData?.get("customerId");

  const isSubmitting = fetcher.state === "submitting";

  const isGlobalDownloading = isSubmitting && submittedAction === "bulk";

  const isHistoryDownloading = isSubmitting && submittedAction === "history";

  const isAdjusting =
    creditFetcher.state === "submitting" || creditFetcher.state === "loading";

  const isTableLoading =
    navigation.state === "loading" || creditFetcher.state === "loading";

  /* ------------------------------------------------------------------------
     ACTION ERROR
     ------------------------------------------------------------------------ */

  const actionError =
    fetcher.data && typeof fetcher.data === "object" && fetcher.data.error
      ? fetcher.data.error
      : null;

  const criticalError = loaderError || actionError;

  /* ------------------------------------------------------------------------
     CURRENT SEARCH
     ------------------------------------------------------------------------ */

  const currentSearch = useMemo(() => {
    return new URLSearchParams(location.search).get("search") || "";
  }, [location.search]);

  /* ------------------------------------------------------------------------
     DOWNLOAD RESPONSE
     ------------------------------------------------------------------------ */

  useEffect(() => {
    /*
     * Only handle completed fetcher requests.
     */
    if (fetcher.state !== "idle") {
      return;
    }

    /*
     * No response.
     */
    if (!fetcher.data) {
      return;
    }

    /*
     * Don't process the same response twice.
     */
    if (downloadHandledRef.current) {
      return;
    }

    /*
     * Error response.
     */
    if (typeof fetcher.data === "object" && fetcher.data.error) {
      downloadHandledRef.current = true;

      shopify.toast.show(fetcher.data.error, {
        isError: true,
      });

      return;
    }

    /*
     * Successful CSV response.
     */
    if (typeof fetcher.data !== "string") {
      return;
    }

    try {
      downloadHandledRef.current = true;

      const blob = new Blob([fetcher.data], {
        type: "text/csv;charset=utf-8",
      });

      const objectUrl = window.URL.createObjectURL(blob);

      const anchor = document.createElement("a");

      anchor.href = objectUrl;

      const timestamp = new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replaceAll(".", "-");

      if (submittedAction === "bulk") {
        anchor.download = `customer-store-credit-report-${timestamp}.csv`;
      } else {
        anchor.download = `customer-history-${timestamp}.csv`;
      }

      anchor.style.display = "none";

      document.body.appendChild(anchor);

      anchor.click();

      anchor.remove();

      /*
       * Don't revoke immediately.
       * Some browsers may cancel the download.
       */
      window.setTimeout(() => {
        window.URL.revokeObjectURL(objectUrl);
      }, 1000);

      if (submittedAction === "bulk") {
        shopify.toast.show("Store credit report downloaded successfully.");
      } else {
        shopify.toast.show("Customer history downloaded successfully.");
      }
    } catch (error) {
      console.error("CSV download error:", error);

      downloadHandledRef.current = true;

      shopify.toast.show("Unable to download the report. Please try again.", {
        isError: true,
      });
    }
  }, [fetcher.data, fetcher.state, submittedAction, shopify]);

  /* ------------------------------------------------------------------------
     RESET DOWNLOAD HANDLER WHEN NEW REQUEST STARTS
     ------------------------------------------------------------------------ */

  useEffect(() => {
    if (fetcher.state === "submitting") {
      downloadHandledRef.current = false;
    }
  }, [fetcher.state]);

  /* ------------------------------------------------------------------------
     PAGINATION
     ------------------------------------------------------------------------ */

  useEffect(() => {
    const table = tableRef.current;

    if (!table) {
      return undefined;
    }

    const handleNextPage = () => {
      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
        return;
      }

      try {
        const params = new URLSearchParams(location.search);

        params.set("cursor", pageInfo.endCursor);

        navigate(`?${params.toString()}`);
      } catch (error) {
        console.error("Pagination error:", error);

        shopify.toast.show("Unable to load the next page.", {
          isError: true,
        });
      }
    };

    table.addEventListener("nextpage", handleNextPage);

    return () => {
      table.removeEventListener("nextpage", handleNextPage);
    };
  }, [
    pageInfo?.hasNextPage,
    pageInfo?.endCursor,
    location.search,
    navigate,
    shopify,
  ]);

  /* ------------------------------------------------------------------------
     GLOBAL REPORT
     ------------------------------------------------------------------------ */

  const downloadBulkReport = () => {
    if (isSubmitting) {
      return;
    }

    downloadHandledRef.current = false;

    fetcher.submit(
      {
        actionType: "bulk",
      },
      {
        method: "POST",
      },
    );
  };

  /* ------------------------------------------------------------------------
     CUSTOMER HISTORY
     ------------------------------------------------------------------------ */

  const downloadHistory = (customerId) => {
    if (!customerId || isSubmitting) {
      return;
    }

    downloadHandledRef.current = false;

    fetcher.submit(
      {
        actionType: "history",
        customerId,
      },
      {
        method: "POST",
      },
    );
  };

  /* ------------------------------------------------------------------------
     CREDIT ADJUSTMENT RESPONSE
     ------------------------------------------------------------------------ */

  useEffect(() => {
    if (creditFetcher.state !== "idle" || !creditFetcher.data) {
      return;
    }

    if (creditFetcher.data?.error) {
      shopify.toast.show(creditFetcher.data.error, {
        isError: true,
      });
      return;
    }

    if (creditFetcher.data?.success) {
      shopify.toast.show(
        creditFetcher.data.message || "Store credit updated successfully.",
      );

      try {
        shopify?.modal?.hide?.("manage-credit-modal");
      } catch (error) {
        console.error("Failed to hide modal:", error);
      }

      setSelectedCustomer(null);
      setAmount("");
      setNote("");
      setExpiresAt("");
      setNotify(true);
    }
  }, [creditFetcher.data, creditFetcher.state, shopify]);

  /* ------------------------------------------------------------------------
     MODAL CONTROLS & SUBMISSION
     ------------------------------------------------------------------------ */

  const handleOpenManageModal = (customer) => {
    setSelectedCustomer(customer);
    setAdjustType("credit");
    setAmount("");
    setNote("");
    setExpiresAt("");
    setNotify(true);

    try {
      shopify?.modal?.show?.("manage-credit-modal");
    } catch (error) {
      console.error("Failed to show modal via App Bridge:", error);
    }
  };

  const handleCloseManageModal = () => {
    try {
      shopify?.modal?.hide?.("manage-credit-modal");
    } catch (error) {
      console.error("Failed to hide modal via App Bridge:", error);
    }

    setSelectedCustomer(null);
    setAmount("");
    setNote("");
    setExpiresAt("");
    setNotify(true);
  };

  const handleCreditSubmit = () => {
    if (!selectedCustomer?.id || isAdjusting) {
      return;
    }

    const numAmount = Number.parseFloat(amount);

    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      shopify.toast.show("Please enter a valid amount greater than 0.", {
        isError: true,
      });
      return;
    }

    const customerCredit = calculateCustomerCredit(
      selectedCustomer,
      shopCurrency,
    );

    if (adjustType === "debit" && numAmount > customerCredit.currentBalance) {
      shopify.toast.show(
        `Deduct amount (${numAmount.toFixed(2)}) exceeds current balance (${formatAmount(customerCredit.currentBalance)}).`,
        { isError: true },
      );
      return;
    }

    creditFetcher.submit(
      {
        actionType: "adjustCredit",
        customerId: selectedCustomer.id,
        adjustType,
        amount: numAmount.toFixed(2),
        currency: customerCredit.currency,
        note: note.trim(),
        expiresAt: expiresAt.trim(),
        notify: String(notify),
      },
      {
        method: "POST",
      },
    );
  };

  /* ------------------------------------------------------------------------
     SEARCH
     ------------------------------------------------------------------------ */

  const handleSearch = (event) => {
    const value = event?.target?.value?.trim() || "";

    try {
      const params = new URLSearchParams(location.search);

      if (value) {
        params.set("search", value);
      } else {
        params.delete("search");
      }

      /*
       * New searches always start
       * from the first page.
       */
      params.delete("cursor");

      navigate(`?${params.toString()}`, {
        replace: true,
      });
    } catch (error) {
      console.error("Search navigation error:", error);

      shopify.toast.show("Unable to perform the search.", {
        isError: true,
      });
    }
  };

  /* ------------------------------------------------------------------------
     RENDER
     ------------------------------------------------------------------------ */

  return (
    <s-page inlineSize="large" heading="Customer Store Credit Report">
      {/* ================================================================
          PRIMARY ACTION
      ================================================================ */}

      <s-button
        slot="primary-action"
        variant="primary"
        icon="download"
        onClick={downloadBulkReport}
        loading={isGlobalDownloading || undefined}
        disabled={isSubmitting || undefined}
      >
        Download Store Credit Report
      </s-button>

      {/* ================================================================
          ERROR
      ================================================================ */}

      {criticalError ? (
        <s-banner variant="critical" heading="Unable to complete the request">
          <p>{criticalError}</p>
        </s-banner>
      ) : null}

      {/* ================================================================
          SEARCH
      ================================================================ */}

      <s-section heading="Search Customers">
        <s-text-field
          placeholder="Search by email or name..."
          value={currentSearch}
          onInput={handleSearch}
          disabled={isTableLoading || undefined}
        />
      </s-section>

      {/* ================================================================
          CUSTOMER TABLE
      ================================================================ */}

      <s-section heading="Customers">
        <s-table
          ref={tableRef}
          paginate
          hasNextPage={pageInfo?.hasNextPage || undefined}
          loading={isTableLoading || undefined}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Name</s-table-header>

            <s-table-header listSlot="secondary">Email</s-table-header>

            <s-table-header listSlot="labeled" format="numeric">
              Total Issued
            </s-table-header>

            <s-table-header listSlot="labeled" format="numeric">
              Total Redeemed
            </s-table-header>

            <s-table-header listSlot="labeled" format="numeric">
              Remaining Balance
            </s-table-header>

            <s-table-header alignment="end">Actions</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {edges.length === 0 ? (
              <s-table-row>
                <s-table-cell>No customers found.</s-table-cell>

                <s-table-cell>—</s-table-cell>

                <s-table-cell>—</s-table-cell>

                <s-table-cell>—</s-table-cell>

                <s-table-cell>—</s-table-cell>

                <s-table-cell>—</s-table-cell>
              </s-table-row>
            ) : (
              edges.map((edge) => {
                const customer = edge?.node;

                if (!customer?.id) {
                  return null;
                }

                const credit = calculateCustomerCredit(customer);

                const isRowDownloading =
                  isHistoryDownloading && submittedCustomerId === customer.id;

                return (
                  <s-table-row key={customer.id}>
                    <s-table-cell>{getCustomerName(customer)}</s-table-cell>

                    <s-table-cell>{getCustomerEmail(customer)}</s-table-cell>

                    <s-table-cell>
                      {`${formatAmount(credit.totalIssued)} ${credit.currency}`}
                    </s-table-cell>

                    <s-table-cell>
                      {`${formatAmount(credit.totalRedeemed)} ${credit.currency
                        }`}
                    </s-table-cell>

                    <s-table-cell>
                      {`${formatAmount(credit.currentBalance)} ${credit.currency
                        }`}
                    </s-table-cell>

                    <s-table-cell alignment="end">
                      <s-stack direction="inline" gap="base">
                        <s-button
                          icon="edit"
                          size="micro"
                          variant="primary"
                          disabled={isSubmitting || isAdjusting || undefined}
                          onClick={() => handleOpenManageModal(customer)}
                        >

                        </s-button>

                        <s-button

                          size="micro"
                          icon="download"
                          loading={isRowDownloading || undefined}
                          disabled={isSubmitting || isAdjusting || undefined}
                          onClick={() => downloadHistory(customer.id)}
                        >

                        </s-button>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })
            )}
          </s-table-body>
        </s-table>
      </s-section>

      {/* ================================================================
          MANAGE STORE CREDIT MODAL
      ================================================================ */}

      <s-modal
        id="manage-credit-modal"
        heading={
          selectedCustomer
            ? `Manage Store Credit: ${getCustomerName(selectedCustomer)}`
            : "Manage Store Credit"
        }
      >
        {selectedCustomer ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              padding: "8px 0",
            }}
          >
            <s-banner variant="info">
              <p>
                <strong>Customer:</strong> {getCustomerName(selectedCustomer)} (
                {getCustomerEmail(selectedCustomer)})
              </p>
              <p style={{ marginTop: "4px" }}>
                <strong>Current Balance:</strong>{" "}
                <span style={{ fontSize: "1.1em", fontWeight: "bold" }}>
                  {`${formatAmount(selectedCustomerCredit.currentBalance)} ${selectedCustomerCredit.currency
                    }`}
                </span>
              </p>
            </s-banner>

            <s-select
              label="Adjustment Type"
              value={adjustType}
              onChange={(e) => setAdjustType(e.target.value)}
              onInput={(e) => setAdjustType(e.target.value)}
            >
              <s-option value="credit">Add Store Credit (+)</s-option>
              <s-option value="debit">Deduct Store Credit (-)</s-option>
            </s-select>

            <s-text-field
              label={`Amount (${selectedCustomerCredit.currency})`}
              type="number"
              step="0.01"
              min="0.01"
              placeholder="0.00"
              value={amount}
              onInput={(e) => setAmount(e.target.value)}
              required
            />

            <div
              style={{
                display: adjustType === "credit" ? "flex" : "none",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <s-date-field
                label="Expiration Date (Optional)"
                value={expiresAt}
                min={todayDate}
                onInput={(e) => setExpiresAt(e.target.value)}
                onChange={(e) => setExpiresAt(e.target.value)}
                details="Leave blank if the credit should never expire."
              />

              <s-checkbox
                label="Send notification email to customer"
                checked={notify || undefined}
                onChange={(e) =>
                  setNotify(
                    e.target.checked !== undefined ? e.target.checked : !notify,
                  )
                }
              />
            </div>

            <s-text-field
              label="Internal Note (Optional)"
              placeholder="Reason for adjustment (e.g. Compensation, Goodwill)"
              value={note}
              onInput={(e) => setNote(e.target.value)}
              details="Internal note for staff; not visible to customer."
            />
          </div>
        ) : null}

        <s-button
          slot="primary-action"
          variant="primary"
          loading={isAdjusting || undefined}
          disabled={isAdjusting || !selectedCustomer || undefined}
          onClick={handleCreditSubmit}
        >
          {adjustType === "credit" ? "Add Credit" : "Deduct Credit"}
        </s-button>

        <s-button
          slot="secondary-actions"
          disabled={isAdjusting || undefined}
          commandFor="manage-credit-modal"
          command="--hide"
          onClick={handleCloseManageModal}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

/* ==========================================================================
   ROUTE ERROR BOUNDARY
   ========================================================================== */

export function ErrorBoundary() {
  const error = useRouteError();

  let title = "Something went wrong";

  let message =
    "An unexpected error occurred while loading the customer report.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Authentication required";

      message = "Your Shopify session has expired. Please reload the page.";
    } else if (error.status === 403) {
      title = "Access denied";

      message = "You do not have permission to access this customer data.";
    } else if (error.status === 404) {
      title = "Page not found";

      message = "The requested resource could not be found.";
    } else if (error.status >= 500) {
      title = "Server error";

      message =
        "The server was unable to process the request. Please try again.";
    } else if (error.statusText) {
      message = error.statusText;
    }
  } else if (error instanceof Error) {
    /*
     * Avoid exposing raw internal errors
     * to the merchant in production.
     */
    console.error("Route ErrorBoundary:", error);

    message =
      "An unexpected application error occurred. Please refresh the page and try again.";
  }

  return (
    <s-page inlineSize="large" heading="Customer Store Credit Report">
      <s-banner variant="critical" heading={title}>
        <p>{message}</p>
      </s-banner>
    </s-page>
  );
}

/* ==========================================================================
   SHOPIFY APP BOUNDARY HEADERS
   ========================================================================== */

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
