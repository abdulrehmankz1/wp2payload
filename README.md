# wp2payload

Early development. Not ready for real migrations yet.

wp2payload will move a WordPress site into Payload CMS 3: posts, pages, media,
categories, tags, authors, SEO metadata and redirects. Re-runs are safe, and a
hacked site's junk stays out of the new one.

Follow progress: https://github.com/abdulrehmankz1/wp2payload

## What works today

```bash
npx wp2payload --version
npx wp2payload doctor   # checks your Node version and that Payload 3 is installed
```

Run `doctor` from inside your Payload project. It writes nothing.

Requires Node 22.12 or newer.

## License

MIT © Abdul Rehman
