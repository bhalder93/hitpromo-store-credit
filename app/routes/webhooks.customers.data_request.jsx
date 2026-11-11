import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} privacy compliance webhook for ${shop}:`,
    payload,
  );

  /**
   * Customers Data Request:
   * A merchant has requested a customer's data on their behalf.
   * If your app stores customer data in a local database, return or email it to the merchant.
   * This app stores all customer data and store credits natively in Shopify and does not
   * persist customer data in external databases.
   */
  return new Response(null, { status: 200 });
};
