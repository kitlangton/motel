export const ATTRIBUTE_FILTER_PREFIX = "attr."
export const ATTRIBUTE_CONTAINS_PREFIX = "attrContains."

export const isAttributeFilterToken = (value: string) =>
	value.startsWith(ATTRIBUTE_FILTER_PREFIX) && value.includes("=")
export const isAttributeContainsToken = (value: string) =>
	value.startsWith(ATTRIBUTE_CONTAINS_PREFIX) && value.includes("=")

export const attributeFiltersFromEntries = (
	entries: Iterable<readonly [string, string]>,
) =>
	Object.fromEntries(
		[...entries]
			.filter(
				([key]) =>
					key.startsWith(ATTRIBUTE_FILTER_PREFIX) &&
					!key.startsWith(ATTRIBUTE_CONTAINS_PREFIX),
			)
			.map(([key, value]) => [
				key.slice(ATTRIBUTE_FILTER_PREFIX.length),
				value,
			]),
	)

export const attributeContainsFiltersFromEntries = (
	entries: Iterable<readonly [string, string]>,
) =>
	Object.fromEntries(
		[...entries]
			.filter(([key]) => key.startsWith(ATTRIBUTE_CONTAINS_PREFIX))
			.map(([key, value]) => [
				key.slice(ATTRIBUTE_CONTAINS_PREFIX.length),
				value,
			]),
	)

export const attributeFiltersFromArgs = (values: readonly string[]) =>
	Object.fromEntries(
		values
			.filter((v) => isAttributeFilterToken(v) && !isAttributeContainsToken(v))
			.map((value) => {
				const index = value.indexOf("=")
				return [
					value.slice(ATTRIBUTE_FILTER_PREFIX.length, index),
					value.slice(index + 1),
				]
			}),
	)

export const attributeContainsFiltersFromArgs = (values: readonly string[]) =>
	Object.fromEntries(
		values.filter(isAttributeContainsToken).map((value) => {
			const index = value.indexOf("=")
			return [
				value.slice(ATTRIBUTE_CONTAINS_PREFIX.length, index),
				value.slice(index + 1),
			]
		}),
	)
