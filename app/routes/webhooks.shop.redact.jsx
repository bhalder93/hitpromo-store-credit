import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(
    `Received ${topic} privacy compliance webhook for ${shop}:`,
    payload,
  );

  /**
   * Shop Redact:
   * 48 hours after a store uninstalls your app, this webhook triggers to delete
   * all remaining data for that shop from your database.
   */
  try {
    await db.session.deleteMany({ where: { shop } });
  } catch (error) {
    console.error(`Error deleting shop sessions during ${topic}:`, error);
  }

  return new Response(null, { status: 200 });
};
