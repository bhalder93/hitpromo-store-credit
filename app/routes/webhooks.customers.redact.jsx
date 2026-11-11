import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} privacy compliance webhook for ${shop}:`,
    payload,
  );

  /**
   * Customers Redact:
   * A customer has requested that their data be deleted from your app.
   * If your app stores customer personal data in a local database, delete or anonymize it here.
   * This app stores all customer data and store credits natively in Shopify and does not
   * persist customer records in external databases.
   */
  return new Response(null, { status: 200 });
};
