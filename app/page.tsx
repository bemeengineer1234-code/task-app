import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black p-4">
      <main className="flex w-full max-w-sm flex-col items-center justify-center py-12 px-8 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-col items-center gap-2 text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            ログイン
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            アカウントにログインしてください
          </p>
        </div>

        <form className="w-full flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-zinc-900 dark:text-zinc-100" htmlFor="email">
              メールアドレス
            </label>
            <input
              type="email"
              id="email"
              className="h-10 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
              placeholder="you@example.com"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-zinc-900 dark:text-zinc-100" htmlFor="password">
              パスワード
            </label>
            <input
              type="password"
              id="password"
              className="h-10 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
            />
          </div>
          <button
            type="button"
            className="mt-4 flex h-10 w-full items-center justify-center rounded-md bg-zinc-900 dark:bg-zinc-50 px-4 text-sm font-medium text-white dark:text-black transition-colors hover:bg-zinc-800 dark:hover:bg-zinc-200"
          >
            ログイン
          </button>
        </form>

        <div className="mt-8 flex flex-col items-center gap-4 w-full">
          <div className="relative w-full">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-zinc-200 dark:border-zinc-800" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white dark:bg-zinc-900 px-2 text-zinc-500">
                初めての方はこちら
              </span>
            </div>
          </div>

          <Link
            href="/register"
            className="flex h-10 w-full items-center justify-center rounded-md border border-zinc-300 dark:border-zinc-700 px-4 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            初回登録
          </Link>
        </div>
      </main>
    </div>
  );
}
