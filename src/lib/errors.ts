export function friendlyDbError(error: unknown) {
  const details = error instanceof Error ? error.message : String(error);

  if (details.includes('D1 is not available in astro dev')) {
    return {
      title: 'Database not available in this runtime',
      message: 'This page needs the Cloudflare D1 database. Use the deployed Worker or Wrangler dev with bindings enabled.',
      details
    };
  }

  if (details.includes('no such table')) {
    return {
      title: 'Database schema is missing or incomplete',
      message: 'The app reached the database, but the expected tables are not present. Cloudflare D1 migrations may need to be applied.',
      details
    };
  }

  return {
    title: 'Something went wrong while loading this page',
    message: 'The server hit an unexpected error. Check the details below or server logs for more information.',
    details
  };
}
