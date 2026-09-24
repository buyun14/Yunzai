export default {
  "*.js": ["prettier --write", "eslint --fix"],
  "*.{json,yml,yaml,md}": ["prettier --write"],
}
