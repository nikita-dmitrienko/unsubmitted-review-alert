# Unsubmitted Review Alert for GitHub

![Opening a pull request with a pending review shows the reminder bar; Finish review opens GitHub's review box](store/assets/screenshots/demo.gif)

You start a review on a pull request, leave a few comments and move on without clicking "Submit review".
Those comments stay pending. Nobody sees them but you.

This Chrome extension reminds you. On a pull request with an unsubmitted review it:

- shows a bar with the number of pending comments and a "Finish review" button
- turns the tab icon into a red warning sign and adds "⚠ PENDING REVIEW" to the tab title
- asks before you leave the pull request, close the tab or reload it

It follows your GitHub theme. The bar works with the keyboard and is labelled for screen readers.

It runs only on github.com and asks for no other access. It makes no network requests and stores nothing.
[Privacy policy](https://nikita-dmitrienko.github.io/unsubmitted-review-alert/privacy-policy.html).

## Install

[Get it from the Chrome Web Store](https://chromewebstore.google.com/detail/unsubmitted-review-alert/mgoijcgmbnhaejfkdcjliiohaiengfbh).

If you use Chrome's Enhanced protection, Chrome may say the extension "is not trusted by Enhanced Safe Browsing".
Chrome shows that for extensions from new publishers, usually for the first few months
([Google's explanation](https://support.google.com/chrome_webstore/answer/2664769)). The code is all here if you want to check it.

To run it from source instead, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the `extension` folder.

## Develop

```bash
npm install
npx playwright install chromium
npm test           # end-to-end tests with the real extension loaded
npm run package    # zip for the Chrome Web Store, in dist/
```

## License

[MIT](LICENSE)
