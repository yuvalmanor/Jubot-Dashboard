import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * The only page reachable without a session. An address outside the two-account
 * allow-list arrives back here with an explicit refusal and never sees a route
 * that renders data.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const errorCode = Array.isArray(error) ? error[0] : error;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <main className="rounded-lg border border-stone-300 bg-white p-6 sm:p-8">
        <h1 className="text-2xl font-bold">Jubot</h1>
        <p className="mt-1 text-sm text-stone-600">לוח מחוונים פיננסי של משק הבית</p>

        {errorCode === undefined ? null : <RefusalNotice code={errorCode} />}

        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md bg-stone-900 px-4 py-2.5 font-medium text-white hover:bg-stone-800"
          >
            כניסה עם חשבון Google
          </button>
        </form>

        <p className="mt-4 text-sm text-stone-500">
          הגישה פתוחה לשני חשבונות משק הבית בלבד. כל כתובת אחרת תידחה.
        </p>
      </main>
    </div>
  );
}

function RefusalNotice({ code }: { code: string }) {
  const isAccessDenied = code === "AccessDenied";
  return (
    <div className="mt-5 rounded-md border border-red-300 bg-red-50 p-4" role="alert">
      <p className="font-medium text-red-900">
        {isAccessDenied ? "הכתובת הזו אינה מורשית" : "ההתחברות נכשלה"}
      </p>
      <p className="mt-1 text-sm text-red-800">
        {isAccessDenied
          ? "רק שני חשבונות משק הבית יכולים להיכנס. לא נוצר עבורך חיבור ולא הוצג שום מידע."
          : "יש לנסות שוב. אם הבעיה חוזרת, יש לבדוק את הגדרות ה־OAuth."}
      </p>
    </div>
  );
}
