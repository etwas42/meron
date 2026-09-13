//! Finding the quoted tail of a reply — the earlier conversation a mail client
//! pastes under the new text — so the conversation view can fold it away the
//! way Gmail does. Every bubble sits right under the message it answers, so an
//! unfolded quote repeats the thread above it.
//!
//! Only a quote that ends the message is folded: one the sender answered inline
//! is part of the reply. A message that is nothing but a quote, and a forward
//! (whose quoted part *is* the content), are left alone.

use ego_tree::{NodeId, NodeRef};
use scraper::{ElementRef, Html, Node, Selector};

/// The attribute [`mark_html_quote`] puts on the quoted tail's elements. The
/// sanitizer drops every `data-*` attribute a sender writes, so an element
/// carrying it was marked here.
pub const HTML_QUOTE_ATTR: &str = "data-meron-quote";

/// Quote containers the common clients write: Gmail's `gmail_quote`, Apple
/// Mail's and Thunderbird's `<blockquote type="cite">`, Yahoo's `yahoo_quoted`.
const HTML_QUOTE_SELECTOR: &str = "div.gmail_quote, blockquote[type=cite i], div.yahoo_quoted";

/// Longest attribution line ("On Mon, … Jane <jane@example.com> wrote:") taken
/// as one; anything longer is a paragraph that happens to end in a colon.
const MAX_ATTRIBUTION_CHARS: usize = 300;

/// Where the quoted tail of a plain body starts — its attribution line when it
/// has one — as a UTF-16 offset into `body`, the unit JavaScript and Kotlin
/// index strings by. `None` when there is nothing to fold.
pub fn plain_quote_start(body: &str) -> Option<usize> {
    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        lines.push((offset, line.trim_end_matches(['\n', '\r'])));
        offset += line.len();
    }
    let blank = |index: usize| lines[index].1.trim().is_empty();
    let quoted = |index: usize| lines[index].1.trim_start().starts_with('>');

    let mut end = lines.len();
    while end > 0 && blank(end - 1) {
        end -= 1;
    }
    // Gmail puts the sender's signature ("-- " and what follows) under the
    // quote. It folds away with the quote rather than hiding the quote from us.
    if let Some(delimiter) = (0..end)
        .rev()
        .find(|&index| lines[index].1.trim_end() == "--")
        && (delimiter..end).all(|index| !quoted(index))
    {
        end = delimiter;
        while end > 0 && blank(end - 1) {
            end -= 1;
        }
    }
    // Walk up through the quoted run. Blank lines inside it belong to it only
    // when more quoted lines sit above them.
    let mut start = end;
    let mut cursor = end;
    while cursor > 0 {
        if quoted(cursor - 1) {
            cursor -= 1;
            start = cursor;
        } else if blank(cursor - 1) {
            cursor -= 1;
        } else {
            break;
        }
    }
    if start == end {
        return None;
    }

    // The attribution sits just above the quote, at most one blank line away.
    let mut above = start;
    if above > 0 && blank(above - 1) {
        above -= 1;
    }
    if above > 0 && is_attribution(lines[above - 1].1) {
        let line = above - 1;
        start = line;
        // Gmail wraps a long attribution at 78 columns, often inside the
        // address: "… Jane Doe <" / "jane@example.com> wrote:". Take the first
        // half too when the second is plainly a continuation of it.
        if line > 0
            && !blank(line - 1)
            && is_attribution_continuation(lines[line - 1].1, lines[line].1)
        {
            start = line - 1;
        }
        let attribution: String = lines[start..=line].iter().map(|(_, text)| *text).collect();
        if is_forward_header(&attribution) {
            return None;
        }
    }

    let byte = lines[start].0;
    if body[..byte].trim().is_empty() {
        return None;
    }
    Some(body[..byte].encode_utf16().count())
}

fn is_attribution(line: &str) -> bool {
    let line = line.trim();
    (line.ends_with(':') || line.ends_with('：'))
        && !line.starts_with('>')
        && line.chars().count() <= MAX_ATTRIBUTION_CHARS
}

/// Whether `second` is the wrapped end of an attribution that starts on `first`.
/// Only a break inside or right after the sender's address counts: a short
/// attribution ("Jane wrote:") on its own says nothing about the line above it,
/// which is usually the end of the reply.
fn is_attribution_continuation(first: &str, second: &str) -> bool {
    let (first, second) = (first.trim(), second.trim());
    if first.starts_with('>') {
        return false;
    }
    // "… Jane Doe <" / "jane@example.com> wrote:" — the address opens on the
    // first line and closes on the second. A complete `<address>` on the second
    // line is an attribution of its own, not the end of the line above.
    let opens_address = match (first.rfind('<'), first.rfind('>')) {
        (Some(open), Some(close)) => open > close,
        (Some(_), None) => true,
        _ => false,
    };
    let split_inside_address = opens_address
        && second
            .split_whitespace()
            .next()
            .is_some_and(|word| !word.starts_with('<') && word.ends_with('>'));
    // "… Jane Doe <jane@example.com>" / "wrote:"
    let split_after_address =
        first.ends_with('>') && first.contains('@') && second.split_whitespace().count() <= 2;
    split_inside_address || split_after_address
}

/// A forward's header ("---------- Forwarded message ---------", Apple's "Begin
/// forwarded message:", Outlook's "-----Original Message-----"): what follows
/// is the content being passed on, not a reply's history.
fn is_forward_header(text: &str) -> bool {
    let text = text.trim_start().to_lowercase();
    text.starts_with("-----") || text.contains("forwarded message")
}

/// Mark the quoted tail of sanitized email HTML with [`HTML_QUOTE_ATTR`]: the
/// quote container and the attribution line right above it. Returns the input
/// untouched when there is nothing to fold.
pub fn mark_html_quote(html: &str) -> String {
    find_and_mark_html_quote(html).unwrap_or_else(|| html.to_string())
}

fn find_and_mark_html_quote(html: &str) -> Option<String> {
    if !html.contains("gmail_quote") && !html.contains("yahoo_quoted") && !html.contains("cite") {
        return None;
    }
    let mut doc = Html::parse_fragment(html);
    let selector = Selector::parse(HTML_QUOTE_SELECTOR).ok()?;

    let quote = doc.select(&selector).find(|el| {
        let outermost = !el
            .ancestors()
            .filter_map(ElementRef::wrap)
            .any(|ancestor| selector.matches(&ancestor));
        outermost && trailing_elements(**el).is_some()
    })?;
    let trailing = trailing_elements(*quote)?;
    if is_forward_header(&quote.text().take(200).collect::<String>()) {
        return None;
    }

    let mut marked = vec![quote.id()];
    let mut top = *quote;
    if let Some(attribution) = attribution_above(*quote) {
        let text: String = attribution.text().collect();
        if is_forward_header(&text) || text.to_lowercase().contains("forward") {
            return None;
        }
        marked.push(attribution.id());
        top = *attribution;
    }
    // The line breaks that set the quote off from the reply fold with it, so
    // the toggle sits right under the reply rather than a blank line below.
    for sibling in top.prev_siblings() {
        match sibling.value() {
            Node::Text(text) if text.trim().is_empty() => continue,
            Node::Element(element) if element.name() == "br" => marked.push(sibling.id()),
            _ => break,
        }
    }
    marked.extend(trailing);
    let folded_away = |node: NodeRef<Node>| {
        node.ancestors()
            .chain(std::iter::once(node))
            .any(|n| marked.contains(&n.id()))
    };
    if !doc
        .tree
        .root()
        .descendants()
        .any(|node| is_content(node) && !folded_away(node))
    {
        return None;
    }

    // Borrow an attribute name off the quote (the selector guarantees it has
    // one) rather than building a `QualName` by hand: only its local name differs.
    let mut name = quote
        .value()
        .attrs
        .iter()
        .next()
        .map(|(name, _)| name.clone())?;
    name.local = HTML_QUOTE_ATTR.into();
    for id in marked {
        if let Some(mut node) = doc.tree.get_mut(id)
            && let Node::Element(element) = node.value()
        {
            element.attrs.extend([(name.clone(), Default::default())]);
        }
    }
    Some(doc.root_element().inner_html())
}

/// Whether nothing the reader would see follows `node` in document order but a
/// signature, which Gmail puts under the quote. Returns the elements after it —
/// the signature and the empty lines around it (`<div><br></div>`, `<br>`) — to
/// fold along with the quote, since left behind they are only blank space under
/// the toggle; `None` when other content follows.
fn trailing_elements(node: NodeRef<Node>) -> Option<Vec<NodeId>> {
    let mut elements = Vec::new();
    let mut current = node;
    loop {
        for sibling in current.next_siblings() {
            if is_signature(sibling) || !sibling.descendants().any(is_content) {
                if sibling.value().is_element() {
                    elements.push(sibling.id());
                }
            } else {
                return None;
            }
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => return Some(elements),
        }
    }
}

/// Gmail's signature and its "-- " prefix, or Thunderbird's signature.
fn is_signature(node: NodeRef<Node>) -> bool {
    node.value().as_element().is_some_and(|element| {
        element.classes().any(|class| {
            matches!(
                class,
                "gmail_signature" | "gmail_signature_prefix" | "moz-signature"
            )
        })
    })
}

/// The element holding the attribution line just above a quote: its previous
/// element sibling, past line breaks and whitespace, when its text reads as one.
fn attribution_above(quote: NodeRef<Node>) -> Option<ElementRef> {
    for sibling in quote.prev_siblings() {
        match sibling.value() {
            Node::Text(text) if text.trim().is_empty() => continue,
            Node::Comment(_) => continue,
            Node::Element(element) if element.name() == "br" => continue,
            Node::Element(_) => {
                let element = ElementRef::wrap(sibling)?;
                let text: String = element.text().collect();
                return is_attribution(&text).then_some(element);
            }
            _ => return None,
        }
    }
    None
}

/// A node the reader sees: text outside `<style>`, or an image or video.
fn is_content(node: NodeRef<Node>) -> bool {
    match node.value() {
        Node::Text(text) => {
            !text
                .chars()
                .all(|c| c.is_whitespace() || c == '\u{200b}' || c == '\u{feff}')
                && !node
                    .parent()
                    .and_then(|parent| parent.value().as_element().map(|el| el.name() == "style"))
                    .unwrap_or(false)
        }
        Node::Element(element) => matches!(element.name(), "img" | "video"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_folds_a_trailing_quote_with_its_attribution() {
        let body = "Sounds good, see you then.\n\nOn Mon, Sep 1, 2025 at 9:00 AM Jane <jane@example.com> wrote:\n> Lunch on Friday?\n>\n> Jane\n";
        let start = plain_quote_start(body).expect("quote");
        assert_eq!(
            &body[start..],
            "On Mon, Sep 1, 2025 at 9:00 AM Jane <jane@example.com> wrote:\n> Lunch on Friday?\n>\n> Jane\n"
        );
    }

    #[test]
    fn plain_takes_a_wrapped_attribution_whole() {
        let body = "Yes.\n\nOn Mon, Sep 1, 2025 at 9:00 AM Jane Doe <\njane@example.com> wrote:\n\n> Lunch?\n";
        let start = plain_quote_start(body).expect("quote");
        assert!(body[start..].starts_with("On Mon"), "{:?}", &body[start..]);
    }

    #[test]
    fn plain_folds_a_signature_under_the_quote_with_it() {
        let body = "Does Tuesday work?\n\nOn Tue, Sep 8, 2026 at 8:14 PM Ping <ping@example.com>\nwrote:\n\n> Both days are good.\n>\n\n\n-- \n\n*MS*\n";
        let start = plain_quote_start(body).expect("quote");
        assert_eq!(&body[..start], "Does Tuesday work?\n\n");
    }

    #[test]
    fn plain_keeps_a_signature_above_the_quote_out_of_it() {
        let body = "Does Tuesday work?\n-- \nMS\n\nOn Mon, Ping wrote:\n> Both days are good.";
        let start = plain_quote_start(body).expect("quote");
        assert_eq!(&body[..start], "Does Tuesday work?\n-- \nMS\n\n");
        // A signature with no quote anywhere is nothing to fold.
        assert_eq!(plain_quote_start("Hi\n-- \nMS"), None);
    }

    #[test]
    fn plain_offset_counts_utf16_units() {
        // "é" is one UTF-16 unit but two bytes; "😀" is two units and four bytes.
        let body = "é😀\n\n> quoted";
        assert_eq!(
            plain_quote_start(body),
            Some("é😀\n\n".encode_utf16().count())
        );
    }

    #[test]
    fn plain_leaves_inline_replies_alone() {
        let body = "> Lunch on Friday?\nYes!\n> Where?\nThe usual place.";
        assert_eq!(plain_quote_start(body), None);
    }

    #[test]
    fn plain_only_folds_the_trailing_quote_of_an_inline_reply() {
        let body = "> Lunch?\nYes!\n\n> older history\n> more";
        let start = plain_quote_start(body).expect("quote");
        assert_eq!(&body[start..], "> older history\n> more");
    }

    #[test]
    fn plain_keeps_a_body_that_is_only_a_quote() {
        assert_eq!(plain_quote_start("On Mon Jane wrote:\n> hi"), None);
        assert_eq!(plain_quote_start("> hi\n> there"), None);
        assert_eq!(plain_quote_start("no quote here"), None);
    }

    #[test]
    fn plain_takes_an_attribution_wrapped_after_the_address() {
        let body = "Yes.\n\nOn Mon, Sep 1, 2025 at 9:00 AM Jane Doe <jane@example.com>\nwrote:\n> Lunch?\n";
        let start = plain_quote_start(body).expect("quote");
        assert_eq!(&body[..start], "Yes.\n\n");
    }

    #[test]
    fn plain_keeps_the_reply_above_a_short_attribution() {
        for attribution in [
            "Jane wrote:",
            "<jane@example.com> wrote:",
            "jane@example.com wrote:",
        ] {
            let body = format!("Hi Bob,\n\nPlease proceed.\n{attribution}\n> Is this approved?");
            let start = plain_quote_start(&body).expect("quote");
            assert_eq!(
                &body[..start],
                "Hi Bob,\n\nPlease proceed.\n",
                "{attribution}"
            );
        }
    }

    #[test]
    fn plain_does_not_fold_the_line_before_an_unwrapped_attribution() {
        let body = "Thanks\nOn Mon, Sep 1, 2025 at 9:00 AM Jane <jane@example.com> wrote:\n> hi";
        let start = plain_quote_start(body).expect("quote");
        assert_eq!(&body[..start], "Thanks\n");
    }

    #[test]
    fn plain_leaves_forwards_alone() {
        let body = "FYI\n\n-----Original Message-----:\n> the content";
        assert_eq!(plain_quote_start(body), None);
    }

    #[test]
    fn html_marks_gmail_quote() {
        let html = r#"<div dir="ltr">Sounds good</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Jane wrote:<br></div><blockquote class="gmail_quote">Lunch?</blockquote></div>"#;
        let out = mark_html_quote(html);
        assert!(
            out.contains(r#"<div class="gmail_quote" data-meron-quote="">"#),
            "{out}"
        );
        // Only the outermost container is marked, not the blockquote inside it.
        assert!(out.contains(r#"<blockquote class="gmail_quote">"#), "{out}");
        // The <br> setting the quote off from the reply folds with it.
        assert!(
            out.contains(r#"</div><br data-meron-quote=""><div"#),
            "{out}"
        );
        assert!(out.contains("Sounds good"));
    }

    #[test]
    fn html_folds_a_gmail_signature_under_the_quote() {
        let html = r#"<div dir="ltr">Does Tuesday work?</div><br><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Tue, Ping wrote:<br></div><blockquote class="gmail_quote"><p>Both days are good.</p></blockquote></div><div><br clear="all"></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature"><b>MS</b></div>"#;
        let out = mark_html_quote(html);
        // The quote, the <br> above it, the two empty divs, the "-- " prefix,
        // the <br> after it and the signature: nothing blank is left behind.
        assert_eq!(out.matches(HTML_QUOTE_ATTR).count(), 7, "{out}");
        assert!(
            out.starts_with(r#"<div dir="ltr">Does Tuesday work?</div><br data-meron-quote="">"#),
            "{out}"
        );
        assert!(out.contains(r#"data-meron-quote=""><b>MS</b>"#), "{out}");
        // Content that isn't a signature after the quote still keeps it open.
        let after = r#"<p>Yes</p><div class="gmail_quote">Lunch?</div><p>P.S. bring cake</p>"#;
        assert_eq!(mark_html_quote(after), after);
        // A quote and a signature with no reply is nothing to fold.
        let bare = r#"<div class="gmail_quote">Lunch?</div><div class="gmail_signature">MS</div>"#;
        assert_eq!(mark_html_quote(bare), bare);
    }

    #[test]
    fn html_marks_apple_and_thunderbird_attribution() {
        let html = r#"<p>Yes!</p><div class="moz-cite-prefix">On 9/1/25 Jane wrote:</div><blockquote type="cite"><p>Lunch?</p></blockquote>"#;
        let out = mark_html_quote(html);
        assert!(
            out.contains(r#"<div class="moz-cite-prefix" data-meron-quote="">"#),
            "{out}"
        );
        assert!(
            out.contains(r#"<blockquote type="cite" data-meron-quote="">"#),
            "{out}"
        );
    }

    #[test]
    fn html_leaves_inline_and_quote_only_bodies_alone() {
        let inline = r#"<blockquote type="cite">Lunch?</blockquote><p>Yes!</p>"#;
        assert_eq!(mark_html_quote(inline), inline);
        let only = r#"<div class="gmail_quote">Lunch?</div>"#;
        assert_eq!(mark_html_quote(only), only);
        let plain = "<p>no quote</p>";
        assert_eq!(mark_html_quote(plain), plain);
    }

    #[test]
    fn html_ignores_trailing_whitespace_and_styles() {
        let html = r#"<p>Yes!</p><div class="gmail_quote">Lunch?</div><div><br></div><style>p{color:red}</style>"#;
        assert!(mark_html_quote(html).contains(HTML_QUOTE_ATTR));
    }

    #[test]
    fn html_leaves_forwards_alone() {
        let gmail = r#"<p>FYI</p><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Jane</div>Content</div>"#;
        assert_eq!(mark_html_quote(gmail), gmail);
        let apple = r#"<p>FYI</p><div>Begin forwarded message:</div><blockquote type="cite">Content</blockquote>"#;
        assert_eq!(mark_html_quote(apple), apple);
    }
}
