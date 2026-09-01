import gzip
import os
import math

class SynctexParser:
    def __init__(self, synctex_path):
        self.synctex_path = synctex_path
        self.inputs = {}  # tag -> filename
        self.nodes = []   # list of dicts: {'tag': tag, 'line': line, 'page': page, 'x': x, 'y': y, 'type': node_type}
        self._parse()

    def _parse(self):
        if not os.path.exists(self.synctex_path):
            return
            
        try:
            with gzip.open(self.synctex_path, 'rt', encoding='utf-8') as f:
                content = f.read()
        except Exception:
            return

        lines = content.split('\n')
        current_page = 1
        
        for line in lines:
            if not line:
                continue
                
            if line.startswith('Input:'):
                parts = line.split(':', 2)
                if len(parts) == 3:
                    tag = parts[1]
                    filename = parts[2].strip()
                    self.inputs[tag] = filename
            elif line.startswith('{'):
                # Page start
                try:
                    current_page = int(line[1:].strip())
                except:
                    pass
            elif line[0] in ('h', 'v', 'x', 'g', 'k', 'f', 'r', 'm', '(', '['):
                    # node: type tag,line:x,y:W,H,D
                    parts = line[1:].split(':')
                    if len(parts) >= 2:
                        tag_line = parts[0].split(',')
                        if len(tag_line) == 2:
                            tag = tag_line[0] # keep as string to match parser.inputs
                            source_line = int(tag_line[1])
                            coords = parts[1].split(',')
                            if len(coords) >= 2:
                                try:
                                    x = int(coords[0]) / 65536.0
                                    y = int(coords[1]) / 65536.0
                                    w = 0
                                    h = 0
                                    if len(parts) >= 3:
                                        dims = parts[2].split(',')
                                        if len(dims) >= 2:
                                            w = int(dims[0]) / 65536.0
                                            h = int(dims[1]) / 65536.0
                                    
                                    self.nodes.append({
                                        'tag': tag,
                                        'line': source_line,
                                        'page': current_page,
                                        'x': x,
                                        'y': y,
                                        'w': w,
                                        'h': h,
                                        'type': line[0]
                                    })
                                except:
                                    pass

def select_record_line(recorded_lines, target_line):
    """Picks which recorded source line covers `target_line`.

    A SyncTeX record carries the line that was current when TeX *shipped* the
    material out, not necessarily the line the material was written on. Anything
    collected into a box and typeset later -- a beamer frame body above all, whose
    whole content is emitted at ``\\end{frame}`` -- is therefore recorded under a
    line at or *after* the one the user edited.

    So when the target line has no record of its own, the record that covers it is
    the next one, never the previous one. Choosing the numerically nearest line
    instead sends the first half of every beamer frame to the slide before it: for
    a frame spanning lines 9-15, line 10 is closer to the preceding frame's record
    (line 7) than to its own (line 15).

    Only when nothing follows the target -- a click past the last typeset line --
    does the closest earlier record win.
    """
    if not recorded_lines:
        return None
    at_or_after = [line for line in recorded_lines if line >= target_line]
    if at_or_after:
        return min(at_or_after)
    return max(recorded_lines)


def find_pdf_position(synctex_path, target_file, target_line):
    """Finds the first node matching the target file and line."""
    parser = SynctexParser(synctex_path)
    
    target_basename = os.path.basename(target_file)
    target_tag = None
    for tag, filename in parser.inputs.items():
        if os.path.basename(filename) == target_basename:
            target_tag = tag
            break
            
    if not target_tag:
        return None
        
    file_nodes = [node for node in parser.nodes if node['tag'] == target_tag]
    best_line = select_record_line({node['line'] for node in file_nodes}, target_line)
    if best_line is None:
        return None

    best_nodes = [node for node in file_nodes if node['line'] == best_line]
    if not best_nodes:
        return None
    
    # Aggregate to find paragraph bounding box using ONLY text nodes ('h', 'x') to avoid glues ('g', 'k') expanding the box too much
    text_nodes = [n for n in best_nodes if n['type'] in ('h', 'x')]
    if not text_nodes:
        text_nodes = best_nodes # fallback if no text nodes
        
    
    
    # Group text nodes by page
    page_counts = {}
    for n in text_nodes:
        p = n['page']
        page_counts[p] = page_counts.get(p, 0) + 1
        
    # Find the page with the most nodes (the actual text, not ToC or headers).
    # A beamer frame with \pause is shipped once per overlay, with every box
    # present on every one of them, so its pages tie here; the -k term breaks
    # that tie towards the first overlay rather than leaving it to node order.
    if not page_counts:
        return None
        
    best_page = max(page_counts.keys(), key=lambda k: (page_counts[k], -k))
    
    # Filter nodes to ONLY those on the best_page
    page_nodes = [n for n in text_nodes if n['page'] == best_page]
    
    # Filter out structural boxes by ensuring width > 20pt (actual text lines are wide)
    text_line_nodes = [n for n in page_nodes if n.get('w', 0) > 20]
    if not text_line_nodes:
        text_line_nodes = page_nodes

    # Use median Y to avoid outliers on this specific page
    y_values = sorted([n['y'] for n in text_line_nodes])
    if y_values:
        median_y = y_values[len(y_values) // 2]
        # Filter nodes that are roughly on the same paragraph
        valid_nodes = [n for n in text_line_nodes if abs(n['y'] - median_y) < 150]
        if not valid_nodes: valid_nodes = text_line_nodes
    else:
        valid_nodes = text_line_nodes
        
    min_y = min([n['y'] for n in valid_nodes], default=best_nodes[0]['y'])
    max_y = max([n['y'] for n in valid_nodes], default=best_nodes[0]['y'])
    min_x = min([n['x'] for n in valid_nodes], default=best_nodes[0]['x'])
    
    # Calculate height. We use max_y - min_y. If they are on the same line, height is fallback 12.
    # Note: y is usually baseline. Top is min_y - 10, Bottom is max_y + 2
    
    page = valid_nodes[0]['page'] if valid_nodes else best_nodes[0]['page']
    
    # Let's find the maximum width based on valid nodes
    max_right = max([n['x'] + (n.get('w', 0) or 0) for n in valid_nodes], default=min_x + 10)
    w = max_right - min_x
    
    # The height is the difference in baselines + an approximation for text height
    h = max_y - min_y + 12
    
    return {
        'page': page,
        'x': min_x,
        'y': min_y - 10, # Adjust y so the box starts ABOVE the baseline
        'w': w,
        'h': h
    }

def find_source_line(synctex_path, page, x, y):
    """Finds the source file and line closest to the PDF coordinates."""
    parser = SynctexParser(synctex_path)
    
    best_node = None
    min_dist = float('inf')
    
    for node in parser.nodes:
        if node['page'] == page:
            dx = node['x'] - x
            dy = node['y'] - y
            dist = dx*dx + (dy*dy * 4) # weight Y
            
            if dist < min_dist:
                min_dist = dist
                best_node = node
                
    if best_node and best_node['tag'] in parser.inputs:
        return {
            'file': parser.inputs[best_node['tag']],
            'line': best_node['line']
        }
    return None
